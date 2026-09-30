/*
 * linkd: runs two GBAs joined by an emulated link cable, headless.
 *
 * Each GBA is an mGBA core on its own thread (mCoreThread), and mGBA's
 * lockstep coordinator connects their serial ports, the same way the mGBA
 * desktop app's "New multiplayer window" does. This is the part of the link
 * server that runs inside the container.
 *
 * Two modes:
 *
 *   linkd [--frames N] [--realtime] [--shots DIR] [--check-linktest]
 *         ROM1 SAVE1 ROM2 SAVE2
 *     Runs for N frames and stops (tests, benchmarks).
 *
 *   linkd --listen PORT [--web DIR] ROM1 SAVE1 ROM2 SAVE2
 *     Runs in real time until SIGINT/SIGTERM, then writes the saves. Each
 *     player connects a WebSocket to /ws?player=1 or /ws?player=2; files in
 *     DIR (the test page) are served at /.
 *
 *   linkd --listen PORT [--web DIR] [--work DIR]
 *     Session mode, for the container: waits for the games over HTTP, runs
 *     them when told to and hands the saves back when told to stop.
 *       GET  /status               {"state":"waiting|running|stopped",
 *                                   "viewers":[player 1's sockets, player 2's]}
 *       PUT  /players/N/rom        the ROM (waiting only)
 *       PUT  /players/N/save       the save, may be empty (waiting only)
 *       PUT  /players/N/state      a snapshot to carry on from instead of
 *                                  powering on, may be empty (waiting only)
 *       POST /start                both ROMs needed
 *       POST /stop                 disconnects players, writes the saves
 *       GET  /players/N/save       the save (stopped only)
 *       GET  /players/N/state      a snapshot of where the game was left
 *                                  (stopped only)
 *     Files go to the work directory (default /tmp/linkd). Snapshots are
 *     mGBA's own (the app's RetroArch core's, unwrapped), battery save
 *     included; the battery save sent with one is the one it holds.
 *
 * WebSocket messages, all binary. Server to client:
 *   0x00 player(u8) width(u16) height(u16)   hello, once
 *   0x01 seq(u32) zlib(delta)                a frame: BGR555 pixels, XORed
 *                                            with the previous frame sent on
 *                                            this socket (zeros at first)
 *   0x02 8 bytes                             echo of a client ping
 *   0x03 rate(u32) mulaw                     sound: mono 8-bit mu-law at
 *                                            rate Hz, in order, no gaps
 * Client to server:
 *   0x01 keys(u16)                           held buttons, GBA bit order
 *   0x02 8 bytes                             ping, echoed back as is
 *   0x03 seq(u32)                            frame drawn; once a client sends
 *                                            these, at most FRAMES_AHEAD
 *                                            frames are in flight to it
 *   0x04 in(u16) drawn(u16) waitAvg(u16)     the client's last ~10 s, logged:
 *        waitMax(u16) pingAvg(u16)           frames received and drawn, ms
 *        pingMax(u16) flags(u8)              from arrival to drawn, ping ms;
 *                                            flags 1 tab hidden, 2 touch
 * Multi-byte numbers are little-endian.
 */

#include <mgba/flags.h>
#include <mgba/core/core.h>
#include <mgba/core/lockstep.h>
#include <mgba/core/log.h>
#include <mgba/core/serialize.h>
#include <mgba/core/thread.h>
#include <mgba/internal/gba/gba.h>
#include <mgba/internal/gba/sio.h>
#include <mgba/internal/gba/sio/lockstep.h>
#include <mgba-util/audio-buffer.h>
#include <mgba-util/vfs.h>

#include "net.h"

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <zlib.h>

#define PLAYERS 2
/* The GBA runs at 16.78 MHz / 280896 cycles per frame, about 59.73 fps. */
#define FRAME_NS 16742706L
#define GBA_KEYS_MASK 0x3FF
/* Sound is streamed at about this rate, and about a second of it is kept
 * per player. */
#define AUDIO_TARGET_RATE 16384
#define AUDIO_RING 16384
/* Frames sent but not yet drawn by the client, at most. 60 fps needs a round
 * trip's worth in flight (6 was 40-50 fps over the ~110 ms players saw in
 * production); a client that can't keep up queues no more than this. */
#define FRAMES_AHEAD 10
/* Send times of the last this many frames, to time them until drawn. */
#define SENT_RING 64
/* How often each player's stream stats are logged. */
#define STATS_SECONDS 10

/* Where linktest.gba writes its results; keep in sync with its RESULT_*. */
#define RESULT_ADDRESS 0x02000000
enum { RESULT_MAGIC, RESULT_PARENT, RESULT_ID, RESULT_MULTI0, RESULT_MULTI1, RESULT_TRANSFERS, RESULT_FRAME, RESULT_COUNT };

enum {
	MSG_HELLO = 0x00,
	MSG_FRAME = 0x01,
	MSG_KEYS = 0x01,
	MSG_PING = 0x02,
	MSG_AUDIO = 0x03,
	MSG_DRAWN = 0x03,
	MSG_CLIENT_STATS = 0x04,
};

struct Player {
	int index;
	const char* romPath;
	const char* savePath;
	/* Snapshot to carry on from, and where the last one is written; NULL
	 * outside session mode. */
	const char* statePath;
	struct mCore* core;
	struct mCoreThread thread;
	struct mLockstepThreadUser user;
	struct GBASIOLockstepDriver driver;
	/* The cable is in this GBA's port (set by onReset). */
	atomic_bool pluggedIn;
	mColor* video;
	unsigned width;
	unsigned height;
	atomic_uint frames;
	struct timespec nextFrame;
	uint16_t result[RESULT_COUNT];

	/* Streaming: held buttons, plus buttons pressed since the last frame so
	 * a tap shorter than a frame still reaches the game. */
	atomic_uint keys;
	atomic_uint tapped;
	/* The latest frame as BGR555, for the sockets to pick up. */
	pthread_mutex_t frameLock;
	pthread_cond_t frameReady;
	uint16_t* frame;
	uint32_t frameSeq;
	/* Sound since the start, as mu-law bytes in a ring; audioWritten counts
	 * every byte ever written, so each socket keeps its own read position. */
	uint8_t audio[AUDIO_RING];
	uint64_t audioWritten;
	unsigned audioRate;
	int16_t* audioScratch;
	size_t audioScratchFrames;
	/* Downsampling carries a partial average over to the next frame. */
	int audioSum;
	unsigned audioCount;
};

static struct GBASIOLockstepCoordinator coordinator;
static struct Player players[PLAYERS];
static bool realtime;
static bool readResults;
static bool streaming;

static void quietLog(struct mLogger* logger, int category, enum mLogLevel level, const char* format, va_list args) {
	(void) logger;
	if (level & (mLOG_FATAL | mLOG_ERROR)) {
		fprintf(stderr, "[%s] ", mLogCategoryName(category));
		vfprintf(stderr, format, args);
		fputc('\n', stderr);
	}
}

static struct mLogger logger = { .log = quietLog };

static int requestedId(struct mLockstepUser* user) {
	/* Player 1 is the parent (player 0 on the cable), player 2 the child. */
	struct Player* player = ((struct mLockstepThreadUser*) user)->thread->userData;
	return player->index;
}

static void onStart(struct mCoreThread* thread) {
	struct Player* player = thread->userData;
	mLockstepThreadUserInit(&player->user, thread);
	player->user.d.requestedId = requestedId;
	GBASIOLockstepDriverCreate(&player->driver, &player->user.d);
	GBASIOLockstepCoordinatorAttach(&coordinator, &player->driver);
	clock_gettime(CLOCK_MONOTONIC, &player->nextFrame);
	/* The cable goes into the port in onReset, once the game is where it
	 * carries on from. */
}

/* clock_nanosleep with TIMER_ABSTIME isn't on macOS, so sleep the difference. */
static void sleepUntil(const struct timespec* deadline) {
	struct timespec now;
	clock_gettime(CLOCK_MONOTONIC, &now);
	long long ns = (long long) (deadline->tv_sec - now.tv_sec) * 1000000000LL + (deadline->tv_nsec - now.tv_nsec);
	if (ns <= 0) {
		return;
	}
	struct timespec wait = { (time_t) (ns / 1000000000LL), (long) (ns % 1000000000LL) };
	while (nanosleep(&wait, &wait) == -1 && errno == EINTR) {}
}

static uint8_t mulaw(int sample) {
	const int bias = 0x84;
	const int clip = 32635;
	int sign = (sample >> 8) & 0x80;
	if (sign) {
		sample = -sample;
	}
	if (sample > clip) {
		sample = clip;
	}
	sample += bias;
	int exponent = 7;
	for (int mask = 0x4000; !(sample & mask) && exponent > 0; mask >>= 1) {
		--exponent;
	}
	int mantissa = (sample >> (exponent + 3)) & 0x0F;
	return (uint8_t) ~(sign | (exponent << 4) | mantissa);
}

/* Takes this frame's sound from the core (stereo, 32 or 65 kHz depending on
 * the game), mixes it to mono, averages it down to about 16 kHz and appends
 * it to the ring as mu-law. Runs on the core thread, the only reader of the
 * core's audio buffer. Caller holds frameLock. */
static void takeAudio(struct Player* player) {
	struct mAudioBuffer* buffer = player->core->getAudioBuffer(player->core);
	size_t available = mAudioBufferAvailable(buffer);
	if (available > player->audioScratchFrames) {
		player->audioScratch = realloc(player->audioScratch, available * 2 * sizeof(int16_t));
		player->audioScratchFrames = available;
	}
	size_t got = mAudioBufferRead(buffer, player->audioScratch, available);
	unsigned rate = player->core->audioSampleRate(player->core);
	unsigned step = rate > AUDIO_TARGET_RATE ? rate / AUDIO_TARGET_RATE : 1;
	player->audioRate = rate / step;
	for (size_t i = 0; i < got; ++i) {
		player->audioSum += player->audioScratch[i * 2] + player->audioScratch[i * 2 + 1];
		if (++player->audioCount == step) {
			player->audio[player->audioWritten % AUDIO_RING] = mulaw(player->audioSum / (int) (2 * step));
			++player->audioWritten;
			player->audioSum = 0;
			player->audioCount = 0;
		}
	}
}

/* mColor here is 32-bit with red in the low byte; the stream sends the
 * GBA's own BGR555. */
static void publishFrame(struct Player* player) {
	size_t pixels = (size_t) player->width * player->height;
	pthread_mutex_lock(&player->frameLock);
	for (size_t i = 0; i < pixels; ++i) {
		uint32_t c = player->video[i];
		player->frame[i] = (uint16_t) (((c >> 3) & 0x1F) | (((c >> 11) & 0x1F) << 5) | (((c >> 19) & 0x1F) << 10));
	}
	takeAudio(player);
	++player->frameSeq;
	pthread_cond_broadcast(&player->frameReady);
	pthread_mutex_unlock(&player->frameLock);
}

/* Snapshots don't keep the timer that ends a transfer on the cable, so a game
 * snapshotted mid-transfer would wait for it forever. End it the way pulling
 * the cable does: nothing came back. */
static void endTransfer(struct mCore* core) {
	struct GBASIO* sio = &((struct GBA*) core->board)->sio;
	mTimingDeschedule(&sio->p->timing, &sio->completeEvent);
	uint16_t none[4] = { 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF };
	switch (sio->mode) {
	case GBA_SIO_MULTI:
		if (GBASIOMultiplayerIsBusy(sio->siocnt)) {
			GBASIOMultiplayerFinishTransfer(sio, none, 0);
		}
		break;
	case GBA_SIO_NORMAL_8:
		if (GBASIONormalIsStart(sio->siocnt)) {
			GBASIONormal8FinishTransfer(sio, 0xFF, 0);
		}
		break;
	case GBA_SIO_NORMAL_32:
		if (GBASIONormalIsStart(sio->siocnt)) {
			GBASIONormal32FinishTransfer(sio, 0xFFFFFFFF, 0);
		}
		break;
	default:
		break;
	}
}

/* Carries on from the snapshot sent for this player, if any; a snapshot that
 * doesn't load leaves the game powered on as usual. */
static void loadSnapshot(struct Player* player, struct mCore* core) {
	if (!player->statePath) {
		return;
	}
	struct VFile* vf = VFileOpen(player->statePath, O_RDONLY);
	if (!vf) {
		return;
	}
	if (vf->size(vf) <= 0) {
		vf->close(vf);
		return;
	}
	bool loaded = mCoreLoadStateNamed(core, vf, SAVESTATE_RTC);
	vf->close(vf);
	if (loaded) {
		endTransfer(core);
		fprintf(stderr, "player %d: carrying on from the snapshot\n", player->index + 1);
	} else {
		fprintf(stderr, "player %d: couldn't load the snapshot, powering on instead\n", player->index + 1);
		core->reset(core);
	}
}

/* After power-on: carry on from the snapshot, then plug the cable in. With
 * the cable already in, loading restarts a transfer the snapshot was in the
 * middle of, and the GBA sleeps waiting for it for good. Plugged in, then
 * reset: the order a GBA got at power-on when the cable went in first. */
static void onReset(struct mCoreThread* thread) {
	struct Player* player = thread->userData;
	loadSnapshot(player, thread->core);
	thread->core->setPeripheral(thread->core, mPERIPH_GBA_LINK_PORT, &player->driver.d);
	player->driver.d.reset(&player->driver.d);
	atomic_store(&player->pluggedIn, true);
}

static void onFrame(struct mCoreThread* thread) {
	struct Player* player = thread->userData;
	if (readResults) {
		for (int i = 0; i < RESULT_COUNT; ++i) {
			player->result[i] = thread->core->rawRead16(thread->core, RESULT_ADDRESS + i * 2, -1);
		}
	}
	if (streaming) {
		unsigned keys = atomic_load(&player->keys) | atomic_exchange(&player->tapped, 0);
		thread->core->setKeys(thread->core, keys);
		publishFrame(player);
	}
	atomic_fetch_add(&player->frames, 1);

	if (realtime) {
		player->nextFrame.tv_nsec += FRAME_NS;
		if (player->nextFrame.tv_nsec >= 1000000000L) {
			player->nextFrame.tv_nsec -= 1000000000L;
			++player->nextFrame.tv_sec;
		}
		sleepUntil(&player->nextFrame);
	}
}

static bool setUpPlayer(struct Player* player) {
	player->core = mCoreFind(player->romPath);
	if (!player->core || !player->core->init(player->core)) {
		fprintf(stderr, "player %d: %s isn't a game mGBA can run\n", player->index + 1, player->romPath);
		return false;
	}
	mCoreInitConfig(player->core, NULL);
	player->core->baseVideoSize(player->core, &player->width, &player->height);
	player->video = calloc((size_t) player->width * player->height, sizeof(mColor));
	player->frame = calloc((size_t) player->width * player->height, sizeof(uint16_t));
	player->core->setVideoBuffer(player->core, player->video, player->width);
	pthread_mutex_init(&player->frameLock, NULL);
	pthread_cond_init(&player->frameReady, NULL);

	if (!mCoreLoadFile(player->core, player->romPath)) {
		fprintf(stderr, "player %d: couldn't load %s\n", player->index + 1, player->romPath);
		return false;
	}
	struct VFile* save = VFileOpen(player->savePath, O_CREAT | O_RDWR);
	if (!save || !player->core->loadSave(player->core, save)) {
		fprintf(stderr, "player %d: couldn't open save %s\n", player->index + 1, player->savePath);
		return false;
	}

	memset(&player->thread, 0, sizeof(player->thread));
	player->thread.core = player->core;
	player->thread.startCallback = onStart;
	player->thread.resetCallback = onReset;
	player->thread.frameCallback = onFrame;
	player->thread.userData = player;
	player->thread.logger.logger = &logger;
	return true;
}

struct Viewer {
	struct Player* player;
	struct WsConn* conn;
	atomic_bool stop;
	/* Frames the client says it drew; zero from clients that don't say. */
	atomic_uint drawn;
	/* How long frames take from being sent to being drawn, for the logs. */
	_Atomic uint32_t sentSeq[SENT_RING];
	_Atomic uint64_t sentAt[SENT_RING];
	_Atomic uint64_t drawnWaitSum;
	atomic_uint drawnWaitCount;
	_Atomic uint64_t drawnWaitMax;
};

static uint64_t nowNs(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (uint64_t) t.tv_sec * 1000000000ULL + (uint64_t) t.tv_nsec;
}

static unsigned getU16(const uint8_t* p) {
	return (unsigned) p[0] | ((unsigned) p[1] << 8);
}

static uint32_t getU32(const uint8_t* p) {
	return (uint32_t) getU16(p) | ((uint32_t) getU16(p + 2) << 16);
}

static void putU16(uint8_t* p, unsigned value) {
	p[0] = (uint8_t) value;
	p[1] = (uint8_t) (value >> 8);
}

static void putU32(uint8_t* p, uint32_t value) {
	for (int i = 0; i < 4; ++i) {
		p[i] = (uint8_t) (value >> (8 * i));
	}
}

/* Sends each new frame as a zlib-compressed XOR against the last one this
 * socket got, so unchanged pixels cost next to nothing. A slow socket skips
 * frames rather than falling behind. The socket itself rarely pushes back
 * (in production it goes into Cloudflare, which queues whatever it gets), so
 * a slow client or connection would build up a growing delay; clients that
 * say which frames they drew get no more than FRAMES_AHEAD in flight. */
static void* viewerSendThread(void* arg) {
	struct Viewer* viewer = arg;
	struct Player* player = viewer->player;
	size_t pixels = (size_t) player->width * player->height;
	size_t bytes = pixels * sizeof(uint16_t);
	uint16_t* current = calloc(pixels, sizeof(uint16_t));
	uint16_t* previous = calloc(pixels, sizeof(uint16_t));
	uint16_t* delta = calloc(pixels, sizeof(uint16_t));
	uLongf capacity = compressBound((uLong) bytes);
	uint8_t* packed = malloc(capacity);
	uint32_t seen = 0;
	unsigned framesSent = 0;
	uint8_t sound[AUDIO_RING];
	size_t soundLength = 0;
	unsigned soundRate = 0;
	uint64_t soundRead;
	pthread_mutex_lock(&player->frameLock);
	soundRead = player->audioWritten;
	pthread_mutex_unlock(&player->frameLock);
	unsigned long long sentBytes = 0;
	unsigned sentFrames = 0;
	unsigned skippedFrames = 0;
	unsigned gameFrames = atomic_load(&player->frames);
	uint64_t since = nowNs();

	while (!atomic_load(&viewer->stop)) {
		pthread_mutex_lock(&player->frameLock);
		while (player->frameSeq == seen && !atomic_load(&viewer->stop)) {
			pthread_cond_wait(&player->frameReady, &player->frameLock);
		}
		seen = player->frameSeq;
		memcpy(current, player->frame, bytes);
		/* All sound since the last send; if this socket fell more than the
		 * ring behind, skip to what's still there. */
		if (player->audioWritten - soundRead > AUDIO_RING) {
			soundRead = player->audioWritten - AUDIO_RING;
		}
		soundLength = (size_t) (player->audioWritten - soundRead);
		for (size_t i = 0; i < soundLength; ++i) {
			sound[i] = player->audio[(soundRead + i) % AUDIO_RING];
		}
		soundRead = player->audioWritten;
		soundRate = player->audioRate;
		pthread_mutex_unlock(&player->frameLock);
		if (atomic_load(&viewer->stop)) {
			break;
		}

		/* Is the game keeping full speed, how much of it gets sent, and how
		 * late it's drawn: what to look at when a player says it lags. */
		uint64_t now = nowNs();
		double elapsed = (double) (now - since) / 1e9;
		if (elapsed >= STATS_SECONDS) {
			unsigned games = atomic_load(&player->frames);
			unsigned waits = atomic_exchange(&viewer->drawnWaitCount, 0);
			uint64_t waitSum = atomic_exchange(&viewer->drawnWaitSum, 0);
			uint64_t waitMax = atomic_exchange(&viewer->drawnWaitMax, 0);
			fprintf(stderr,
			        "player %d stream: game %.1f fps, sent %.1f fps, skipped %u for the client to catch up, %.0f kbit/s, "
			        "sent to drawn avg %.0f ms max %.0f ms\n",
			        player->index + 1, (games - gameFrames) / elapsed, sentFrames / elapsed, skippedFrames,
			        sentBytes * 8 / elapsed / 1000, waits ? (double) waitSum / waits / 1e6 : 0, (double) waitMax / 1e6);
			gameFrames = games;
			sentBytes = 0;
			sentFrames = 0;
			skippedFrames = 0;
			since = now;
		}

		if (soundLength) {
			uint8_t soundHead[5] = { MSG_AUDIO };
			putU32(soundHead + 1, soundRate);
			if (!wsSend(viewer->conn, soundHead, sizeof(soundHead), sound, soundLength)) {
				break;
			}
			sentBytes += sizeof(soundHead) + soundLength;
		}

		unsigned drawn = atomic_load(&viewer->drawn);
		if (drawn && (int) (framesSent - drawn) >= FRAMES_AHEAD) {
			++skippedFrames;
			continue;
		}

		for (size_t i = 0; i < pixels; ++i) {
			delta[i] = current[i] ^ previous[i];
		}
		uLongf packedLength = capacity;
		if (compress2(packed, &packedLength, (const Bytef*) delta, (uLong) bytes, 1) != Z_OK) {
			break;
		}
		uint8_t head[5] = { MSG_FRAME };
		putU32(head + 1, seen);
		if (!wsSend(viewer->conn, head, sizeof(head), packed, packedLength)) {
			break;
		}
		atomic_store(&viewer->sentAt[seen % SENT_RING], nowNs());
		atomic_store(&viewer->sentSeq[seen % SENT_RING], seen);
		uint16_t* swap = previous;
		previous = current;
		current = swap;

		sentBytes += sizeof(head) + packedLength;
		++sentFrames;
		++framesSent;
	}
	free(current);
	free(previous);
	free(delta);
	free(packed);
	return NULL;
}

enum SessionState { SESSION_WAITING, SESSION_RUNNING, SESSION_STOPPED };

/* Guards the session state and the list of connected viewers. */
static pthread_mutex_t sessionLock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t viewersChanged = PTHREAD_COND_INITIALIZER;
static enum SessionState sessionState = SESSION_WAITING;
#define MAX_VIEWERS 16
static struct Viewer* viewers[MAX_VIEWERS];
static int viewerCount;
static const char* workDir = "/tmp/linkd";
/* Per player: ROM, save, snapshot. */
static char workPaths[PLAYERS][3][4096];

static bool addViewer(struct Viewer* viewer) {
	pthread_mutex_lock(&sessionLock);
	bool ok = sessionState == SESSION_RUNNING && viewerCount < MAX_VIEWERS;
	if (ok) {
		viewers[viewerCount++] = viewer;
	}
	pthread_mutex_unlock(&sessionLock);
	return ok;
}

static void removeViewer(struct Viewer* viewer) {
	pthread_mutex_lock(&sessionLock);
	for (int i = 0; i < viewerCount; ++i) {
		if (viewers[i] == viewer) {
			viewers[i] = viewers[--viewerCount];
			break;
		}
	}
	pthread_cond_broadcast(&viewersChanged);
	pthread_mutex_unlock(&sessionLock);
}

static void onSocket(struct WsConn* conn, const char* path, void* context) {
	(void) context;
	int index;
	if (sscanf(path, "/ws?player=%d", &index) != 1 || index < 1 || index > PLAYERS) {
		return;
	}
	struct Player* player = &players[index - 1];
	struct Viewer viewer = { .player = player, .conn = conn };
	atomic_init(&viewer.stop, false);
	atomic_init(&viewer.drawn, 0);
	if (!addViewer(&viewer)) {
		return;
	}
	fprintf(stderr, "player %d: connected\n", index);

	uint8_t hello[6] = { MSG_HELLO, (uint8_t) index };
	putU16(hello + 2, player->width);
	putU16(hello + 4, player->height);
	pthread_t sender;
	if (!wsSend(conn, hello, sizeof(hello), NULL, 0) || pthread_create(&sender, NULL, viewerSendThread, &viewer) != 0) {
		removeViewer(&viewer);
		return;
	}

	uint8_t message[64];
	size_t length;
	while (wsRead(conn, message, sizeof(message), &length) == WS_BINARY) {
		if (message[0] == MSG_KEYS && length == 3) {
			unsigned keys = (unsigned) (message[1] | (message[2] << 8)) & GBA_KEYS_MASK;
			atomic_store(&player->keys, keys);
			atomic_fetch_or(&player->tapped, keys);
		} else if (message[0] == MSG_DRAWN && length == 5) {
			atomic_fetch_add(&viewer.drawn, 1);
			uint32_t seq = getU32(message + 1);
			if (atomic_load(&viewer.sentSeq[seq % SENT_RING]) == seq) {
				uint64_t wait = nowNs() - atomic_load(&viewer.sentAt[seq % SENT_RING]);
				atomic_fetch_add(&viewer.drawnWaitSum, wait);
				atomic_fetch_add(&viewer.drawnWaitCount, 1);
				uint64_t max = atomic_load(&viewer.drawnWaitMax);
				while (wait > max && !atomic_compare_exchange_weak(&viewer.drawnWaitMax, &max, wait)) {}
			}
		} else if (message[0] == MSG_CLIENT_STATS && length == 14) {
			unsigned flags = message[13];
			fprintf(stderr,
			        "player %d client: %u frames in, %u drawn, arrival to drawn avg %u ms max %u ms, ping avg %u ms max %u ms, "
			        "%s, tab %s\n",
			        index, getU16(message + 1), getU16(message + 3), getU16(message + 5), getU16(message + 7),
			        getU16(message + 9), getU16(message + 11), (flags & 2) ? "touch" : "no touch",
			        (flags & 1) ? "hidden" : "visible");
		} else if (message[0] == MSG_PING && length == 9) {
			wsSend(conn, message, length, NULL, 0);
		}
	}

	/* Let go of every button, like a player putting the GBA down. */
	atomic_store(&player->keys, 0);
	atomic_store(&viewer.stop, true);
	pthread_mutex_lock(&player->frameLock);
	pthread_cond_broadcast(&player->frameReady);
	pthread_mutex_unlock(&player->frameLock);
	pthread_join(sender, NULL);
	removeViewer(&viewer);
	fprintf(stderr, "player %d: disconnected\n", index);
}

static bool writeFile(const char* path, const uint8_t* data, size_t length);

static bool startSession(void) {
	for (int i = 0; i < PLAYERS; ++i) {
		if (!setUpPlayer(&players[i])) {
			return false;
		}
	}
	for (int i = 0; i < PLAYERS; ++i) {
		atomic_store(&players[i].pluggedIn, false);
		if (!mCoreThreadStart(&players[i].thread)) {
			fprintf(stderr, "player %d: couldn't start\n", i + 1);
			return false;
		}
		/* One at a time: the first on the cable is the parent until the
		 * other plugs in, and a game that doesn't set up its link again
		 * (one carrying on from a snapshot) keeps the place it saw. */
		struct timespec poll = { 0, 1000000L };
		for (int waited = 0; !atomic_load(&players[i].pluggedIn); ++waited) {
			if (waited == 10000) {
				fprintf(stderr, "player %d: the cable never went in\n", i + 1);
				return false;
			}
			nanosleep(&poll, NULL);
		}
	}
	return true;
}

/* Disconnects everyone, stops both GBAs and writes their saves. */
static void stopSession(void) {
	pthread_mutex_lock(&sessionLock);
	if (sessionState != SESSION_RUNNING) {
		pthread_mutex_unlock(&sessionLock);
		return;
	}
	sessionState = SESSION_STOPPED;
	for (int i = 0; i < viewerCount; ++i) {
		wsShutdown(viewers[i]->conn);
	}
	while (viewerCount) {
		pthread_cond_wait(&viewersChanged, &sessionLock);
	}
	pthread_mutex_unlock(&sessionLock);

	for (int i = 0; i < PLAYERS; ++i) {
		mCoreThreadEnd(&players[i].thread);
	}
	for (int i = 0; i < PLAYERS; ++i) {
		mCoreThreadJoin(&players[i].thread);
		/* The save file keeps the size it came in with (the app's core pads
		 * saves it hasn't sized yet to 128 KiB); the core knows the real
		 * size, which is what the app's core stores too. */
		void* sram = NULL;
		size_t size = players[i].core->savedataClone(players[i].core, &sram);
		/* Where the game was left, for the app to carry on from (the same
		 * flags as its core's snapshots). */
		endTransfer(players[i].core);
		struct VFile* state = players[i].statePath ? VFileOpen(players[i].statePath, O_CREAT | O_TRUNC | O_RDWR) : NULL;
		if (players[i].statePath && (!state || !mCoreSaveStateNamed(players[i].core, state, SAVESTATE_SAVEDATA | SAVESTATE_RTC))) {
			fprintf(stderr, "player %d: couldn't take a snapshot\n", i + 1);
		}
		if (state) {
			state->close(state);
		}
		players[i].core->deinit(players[i].core);
		if (size && !writeFile(players[i].savePath, sram, size)) {
			fprintf(stderr, "player %d: couldn't trim the save\n", i + 1);
		}
		free(sram);
	}
	GBASIOLockstepCoordinatorDeinit(&coordinator);
	fprintf(stderr, "session stopped, saves and snapshots written\n");
}

static bool writeFile(const char* path, const uint8_t* data, size_t length) {
	FILE* file = fopen(path, "wb");
	if (!file) {
		return false;
	}
	bool ok = fwrite(data, 1, length, file) == length;
	return fclose(file) == 0 && ok;
}

static uint8_t* readFile(const char* path, size_t* length) {
	FILE* file = fopen(path, "rb");
	if (!file) {
		return NULL;
	}
	fseek(file, 0, SEEK_END);
	long size = ftell(file);
	fseek(file, 0, SEEK_SET);
	uint8_t* data = malloc(size > 0 ? (size_t) size : 1);
	*length = size > 0 ? fread(data, 1, (size_t) size, file) : 0;
	fclose(file);
	return data;
}

static void respondText(struct HttpResponse* response, int status, const char* text) {
	response->status = status;
	response->contentType = "application/json";
	response->length = strlen(text);
	response->body = (uint8_t*) strdup(text);
}

static bool onHttp(const char* method, const char* path, const uint8_t* body, size_t length,
                   struct HttpResponse* response, void* context) {
	(void) context;
	int index;
	char kind[8];
	bool playerPath = sscanf(path, "/players/%d/%7s", &index, kind) == 2 && index >= 1 && index <= PLAYERS &&
	                  (!strcmp(kind, "rom") || !strcmp(kind, "save") || !strcmp(kind, "state"));
	int file = !playerPath ? 0 : !strcmp(kind, "save") ? 1 : !strcmp(kind, "state") ? 2 : 0;

	pthread_mutex_lock(&sessionLock);
	enum SessionState state = sessionState;
	int watching[PLAYERS] = { 0 };
	for (int i = 0; i < viewerCount; ++i) {
		++watching[viewers[i]->player->index];
	}
	pthread_mutex_unlock(&sessionLock);

	if (!strcmp(path, "/status")) {
		static const char* names[] = { "waiting", "running", "stopped" };
		char text[96];
		snprintf(text, sizeof(text), "{\"state\":\"%s\",\"viewers\":[%d,%d]}", names[state], watching[0], watching[1]);
		respondText(response, 200, text);
		return true;
	}
	if (playerPath && !strcmp(method, "PUT")) {
		if (state != SESSION_WAITING) {
			respondText(response, 409, "{\"error\":\"not_waiting\"}");
		} else if (!writeFile(workPaths[index - 1][file], body, length)) {
			respondText(response, 500, "{\"error\":\"write_failed\"}");
		} else {
			response->status = 204;
		}
		return true;
	}
	if (playerPath && file && !strcmp(method, "GET")) {
		if (state != SESSION_STOPPED) {
			respondText(response, 409, "{\"error\":\"not_stopped\"}");
			return true;
		}
		response->body = readFile(workPaths[index - 1][file], &response->length);
		response->status = response->body ? 200 : 404;
		return true;
	}
	if (!strcmp(path, "/start") && !strcmp(method, "POST")) {
		pthread_mutex_lock(&sessionLock);
		if (sessionState != SESSION_WAITING) {
			pthread_mutex_unlock(&sessionLock);
			respondText(response, 409, "{\"error\":\"not_waiting\"}");
			return true;
		}
		for (int i = 0; i < PLAYERS; ++i) {
			FILE* rom = fopen(workPaths[i][0], "rb");
			if (!rom) {
				pthread_mutex_unlock(&sessionLock);
				respondText(response, 409, "{\"error\":\"missing_rom\"}");
				return true;
			}
			fclose(rom);
			/* No save sent means a fresh one. */
			FILE* save = fopen(workPaths[i][1], "ab");
			if (save) {
				fclose(save);
			}
		}
		bool started = startSession();
		sessionState = started ? SESSION_RUNNING : SESSION_STOPPED;
		pthread_mutex_unlock(&sessionLock);
		if (started) {
			response->status = 204;
		} else {
			respondText(response, 500, "{\"error\":\"start_failed\"}");
		}
		return true;
	}
	if (!strcmp(path, "/stop") && !strcmp(method, "POST")) {
		stopSession();
		response->status = 204;
		return true;
	}
	return false;
}

struct ServeArgs {
	int port;
	const char* webDir;
};

static void* serveThread(void* arg) {
	struct ServeArgs* args = arg;
	if (!netServe(args->port, args->webDir, onHttp, onSocket, NULL)) {
		kill(getpid(), SIGTERM);
	}
	return NULL;
}

static void writeShot(struct Player* player, const char* dir) {
	char path[4096];
	snprintf(path, sizeof(path), "%s/player%d.png", dir, player->index + 1);
	struct VFile* vf = VFileOpen(path, O_CREAT | O_TRUNC | O_WRONLY);
	if (!vf || !mCoreTakeScreenshotVF(player->core, vf)) {
		fprintf(stderr, "couldn't write %s\n", path);
	}
	if (vf) {
		vf->close(vf);
	}
}

/* linktest.gba: the parent must have received the child's 0x2xxx words and
 * the child the parent's 0x1xxx words. */
static bool checkLinktest(void) {
	const uint16_t* parent = players[0].result;
	const uint16_t* child = players[1].result;
	printf("player 1: parent=%u id=%u multi0=%04x multi1=%04x transfers=%u frame=%u\n",
	       parent[RESULT_PARENT], parent[RESULT_ID], parent[RESULT_MULTI0], parent[RESULT_MULTI1],
	       parent[RESULT_TRANSFERS], parent[RESULT_FRAME]);
	printf("player 2: parent=%u id=%u multi0=%04x multi1=%04x transfers=%u frame=%u\n",
	       child[RESULT_PARENT], child[RESULT_ID], child[RESULT_MULTI0], child[RESULT_MULTI1],
	       child[RESULT_TRANSFERS], child[RESULT_FRAME]);
	bool ok = parent[RESULT_MAGIC] == 0x4C4B && child[RESULT_MAGIC] == 0x4C4B;
	ok = ok && parent[RESULT_PARENT] == 1 && child[RESULT_PARENT] == 0;
	ok = ok && (parent[RESULT_MULTI1] & 0xF000) == 0x2000;
	ok = ok && (child[RESULT_MULTI0] & 0xF000) == 0x1000;
	ok = ok && parent[RESULT_TRANSFERS] > 0;
	return ok;
}

static void usage(void) {
	fprintf(stderr,
	        "usage: linkd [--frames N] [--realtime] [--shots DIR] [--check-linktest] ROM1 SAVE1 ROM2 SAVE2\n"
	        "       linkd --listen PORT [--web DIR] ROM1 SAVE1 ROM2 SAVE2\n"
	        "       linkd --listen PORT [--web DIR] [--work DIR]\n");
}

int main(int argc, char** argv) {
	unsigned frames = 600;
	const char* shots = NULL;
	bool checkTest = false;
	int port = 0;
	const char* webDir = NULL;
	const char* paths[PLAYERS * 2];
	int nPaths = 0;

	for (int i = 1; i < argc; ++i) {
		if (!strcmp(argv[i], "--frames") && i + 1 < argc) {
			frames = (unsigned) strtoul(argv[++i], NULL, 10);
		} else if (!strcmp(argv[i], "--realtime")) {
			realtime = true;
		} else if (!strcmp(argv[i], "--shots") && i + 1 < argc) {
			shots = argv[++i];
		} else if (!strcmp(argv[i], "--check-linktest")) {
			checkTest = true;
		} else if (!strcmp(argv[i], "--listen") && i + 1 < argc) {
			port = atoi(argv[++i]);
		} else if (!strcmp(argv[i], "--web") && i + 1 < argc) {
			webDir = argv[++i];
		} else if (!strcmp(argv[i], "--work") && i + 1 < argc) {
			workDir = argv[++i];
		} else if (argv[i][0] == '-' || nPaths == PLAYERS * 2) {
			usage();
			return 2;
		} else {
			paths[nPaths++] = argv[i];
		}
	}
	bool sessionMode = port > 0 && nPaths == 0;
	if ((nPaths != PLAYERS * 2 && !sessionMode) || port < 0 || port > 65535) {
		usage();
		return 2;
	}
	readResults = checkTest;
	streaming = port > 0;
	if (streaming) {
		realtime = true;
	}

	/* The core and socket threads inherit this mask, so SIGINT/SIGTERM only
	 * reach the main thread's sigwait and the saves get written. */
	sigset_t stopSignals;
	sigemptyset(&stopSignals);
	sigaddset(&stopSignals, SIGINT);
	sigaddset(&stopSignals, SIGTERM);
	pthread_sigmask(SIG_BLOCK, &stopSignals, NULL);
	signal(SIGPIPE, SIG_IGN);

	mLogSetDefaultLogger(&logger);
	GBASIOLockstepCoordinatorInit(&coordinator);

	if (sessionMode) {
		mkdir(workDir, 0700);
	}
	for (int i = 0; i < PLAYERS; ++i) {
		players[i].index = i;
		if (sessionMode) {
			snprintf(workPaths[i][0], sizeof(workPaths[i][0]), "%s/player%d.gba", workDir, i + 1);
			snprintf(workPaths[i][1], sizeof(workPaths[i][1]), "%s/player%d.sav", workDir, i + 1);
			snprintf(workPaths[i][2], sizeof(workPaths[i][2]), "%s/player%d.state", workDir, i + 1);
			players[i].romPath = workPaths[i][0];
			players[i].savePath = workPaths[i][1];
			players[i].statePath = workPaths[i][2];
		} else {
			players[i].romPath = paths[i * 2];
			players[i].savePath = paths[i * 2 + 1];
		}
	}

	if (streaming) {
		if (!sessionMode) {
			if (!startSession()) {
				return 1;
			}
			sessionState = SESSION_RUNNING;
		}
		struct ServeArgs serveArgs = { port, webDir };
		pthread_t server;
		pthread_create(&server, NULL, serveThread, &serveArgs);
		pthread_detach(server);
		fprintf(stderr, "listening on port %d%s\n", port, sessionMode ? ", waiting for games" : "");
		int received;
		sigwait(&stopSignals, &received);
		fprintf(stderr, "stopping\n");
		stopSession();
		return 0;
	}

	struct timespec started, now;
	clock_gettime(CLOCK_MONOTONIC, &started);
	if (!startSession()) {
		return 1;
	}
	sessionState = SESSION_RUNNING;
	struct timespec poll = { 0, 1000000L };
	while (atomic_load(&players[0].frames) < frames || atomic_load(&players[1].frames) < frames) {
		if (mCoreThreadHasCrashed(&players[0].thread) || mCoreThreadHasCrashed(&players[1].thread)) {
			fprintf(stderr, "a core crashed\n");
			return 1;
		}
		nanosleep(&poll, NULL);
	}
	clock_gettime(CLOCK_MONOTONIC, &now);

	for (int i = 0; i < PLAYERS; ++i) {
		mCoreThreadInterrupt(&players[i].thread);
	}
	double seconds = (double) (now.tv_sec - started.tv_sec) + (now.tv_nsec - started.tv_nsec) / 1e9;
	printf("ran %u frames per GBA in %.2f s (%.0f fps each)\n",
	       atomic_load(&players[0].frames), seconds, atomic_load(&players[0].frames) / seconds);

	bool ok = true;
	if (checkTest) {
		ok = checkLinktest();
		printf("link test: %s\n", ok ? "PASS" : "FAIL");
	}
	if (shots) {
		for (int i = 0; i < PLAYERS; ++i) {
			writeShot(&players[i], shots);
		}
	}
	for (int i = 0; i < PLAYERS; ++i) {
		mCoreThreadContinue(&players[i].thread);
	}
	stopSession();
	return ok ? 0 : 1;
}
