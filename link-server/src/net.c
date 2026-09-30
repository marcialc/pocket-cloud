#include "net.h"

#include <mgba/flags.h>
#include <mgba-util/sha1.h>

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <unistd.h>

#define MAX_REQUEST 8192
#define WS_GUID "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

struct Server {
	const char* webDir;
	HttpHandler http;
	WsHandler handler;
	void* context;
};

struct Client {
	struct Server* server;
	int fd;
};

static bool writeAll(int fd, const void* data, size_t length) {
	const uint8_t* p = data;
	while (length) {
		ssize_t n = write(fd, p, length);
		if (n < 0 && errno == EINTR) {
			continue;
		}
		if (n <= 0) {
			return false;
		}
		p += n;
		length -= (size_t) n;
	}
	return true;
}

static bool readAll(int fd, void* data, size_t length) {
	uint8_t* p = data;
	while (length) {
		ssize_t n = read(fd, p, length);
		if (n < 0 && errno == EINTR) {
			continue;
		}
		if (n <= 0) {
			return false;
		}
		p += n;
		length -= (size_t) n;
	}
	return true;
}

static void base64(const uint8_t* in, size_t length, char* out) {
	static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	size_t i;
	for (i = 0; i + 2 < length; i += 3) {
		*out++ = table[in[i] >> 2];
		*out++ = table[((in[i] & 3) << 4) | (in[i + 1] >> 4)];
		*out++ = table[((in[i + 1] & 15) << 2) | (in[i + 2] >> 6)];
		*out++ = table[in[i + 2] & 63];
	}
	if (i < length) {
		*out++ = table[in[i] >> 2];
		if (i + 1 < length) {
			*out++ = table[((in[i] & 3) << 4) | (in[i + 1] >> 4)];
			*out++ = table[(in[i + 1] & 15) << 2];
		} else {
			*out++ = table[(in[i] & 3) << 4];
			*out++ = '=';
		}
		*out++ = '=';
	}
	*out = '\0';
}

/* Finds a header's value in a raw request; copies at most capacity-1 bytes. */
static bool findHeader(const char* request, const char* name, char* value, size_t capacity) {
	size_t nameLength = strlen(name);
	for (const char* line = strstr(request, "\r\n"); line; line = strstr(line, "\r\n")) {
		line += 2;
		if (strncasecmp(line, name, nameLength) == 0 && line[nameLength] == ':') {
			const char* start = line + nameLength + 1;
			while (*start == ' ') {
				++start;
			}
			const char* end = strstr(start, "\r\n");
			size_t length = end ? (size_t) (end - start) : strlen(start);
			if (length >= capacity) {
				return false;
			}
			memcpy(value, start, length);
			value[length] = '\0';
			return true;
		}
	}
	return false;
}

static const char* statusText(int status) {
	switch (status) {
	case 200: return "200 OK";
	case 204: return "204 No Content";
	case 400: return "400 Bad Request";
	case 404: return "404 Not Found";
	case 405: return "405 Method Not Allowed";
	case 409: return "409 Conflict";
	case 413: return "413 Payload Too Large";
	default: return "500 Internal Server Error";
	}
}

static void sendResponse(int fd, const struct HttpResponse* response) {
	char head[256];
	int length = snprintf(head, sizeof(head),
	                      "HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n",
	                      statusText(response->status),
	                      response->contentType ? response->contentType : "application/octet-stream",
	                      response->length);
	if (writeAll(fd, head, (size_t) length) && response->length) {
		writeAll(fd, response->body, response->length);
	}
}

static void sendStatus(int fd, const char* status) {
	char response[256];
	int length = snprintf(response, sizeof(response),
	                      "HTTP/1.1 %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", status);
	writeAll(fd, response, (size_t) length);
}

static const char* contentType(const char* name) {
	const char* dot = strrchr(name, '.');
	if (dot && !strcmp(dot, ".html")) {
		return "text/html; charset=utf-8";
	}
	if (dot && !strcmp(dot, ".js")) {
		return "text/javascript; charset=utf-8";
	}
	if (dot && !strcmp(dot, ".css")) {
		return "text/css; charset=utf-8";
	}
	return "application/octet-stream";
}

/* Serves one file from webDir. Names are limited to [a-z0-9.-] with no
 * leading dot, so a request can't leave the directory. */
static void serveFile(struct Server* server, int fd, const char* path) {
	char name[128];
	const char* query = strchr(path, '?');
	size_t length = query ? (size_t) (query - path) : strlen(path);
	if (length == 1) {
		strcpy(name, "index.html");
	} else if (length - 1 < sizeof(name)) {
		memcpy(name, path + 1, length - 1);
		name[length - 1] = '\0';
	} else {
		sendStatus(fd, "404 Not Found");
		return;
	}
	for (const char* c = name; *c; ++c) {
		if (!((*c >= 'a' && *c <= 'z') || (*c >= '0' && *c <= '9') || *c == '.' || *c == '-') || name[0] == '.') {
			sendStatus(fd, "404 Not Found");
			return;
		}
	}
	if (!server->webDir) {
		sendStatus(fd, "404 Not Found");
		return;
	}

	char file[4096];
	snprintf(file, sizeof(file), "%s/%s", server->webDir, name);
	int in = open(file, O_RDONLY);
	struct stat info;
	if (in < 0 || fstat(in, &info) < 0 || !S_ISREG(info.st_mode)) {
		if (in >= 0) {
			close(in);
		}
		sendStatus(fd, "404 Not Found");
		return;
	}
	char head[512];
	int headLength = snprintf(head, sizeof(head),
	                          "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %lld\r\n"
	                          "Cache-Control: no-store\r\nConnection: close\r\n\r\n",
	                          contentType(name), (long long) info.st_size);
	if (writeAll(fd, head, (size_t) headLength)) {
		char buffer[16384];
		ssize_t n;
		while ((n = read(in, buffer, sizeof(buffer))) > 0 && writeAll(fd, buffer, (size_t) n)) {}
	}
	close(in);
}

static void upgrade(struct Server* server, int fd, const char* request, const char* path) {
	char key[128];
	if (!findHeader(request, "Sec-WebSocket-Key", key, sizeof(key))) {
		sendStatus(fd, "400 Bad Request");
		return;
	}
	char joined[sizeof(key) + sizeof(WS_GUID)];
	snprintf(joined, sizeof(joined), "%s%s", key, WS_GUID);
	uint8_t digest[20];
	sha1Buffer(joined, strlen(joined), digest);
	char accept[32];
	base64(digest, sizeof(digest), accept);

	char response[256];
	int length = snprintf(response, sizeof(response),
	                      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
	                      "Sec-WebSocket-Accept: %s\r\n\r\n",
	                      accept);
	if (!writeAll(fd, response, (size_t) length)) {
		return;
	}

	struct WsConn conn = { .fd = fd };
	pthread_mutex_init(&conn.writeLock, NULL);
	server->handler(&conn, path, server->context);
	pthread_mutex_destroy(&conn.writeLock);
}

/* Reads the body announced by Content-Length; `extra` bytes of it already
 * arrived with the headers. */
static uint8_t* readBody(int fd, const char* request, const char* extra, size_t extraLength, size_t* length, int* status) {
	char value[32];
	*length = 0;
	if (!findHeader(request, "Content-Length", value, sizeof(value))) {
		return NULL;
	}
	unsigned long long declared = strtoull(value, NULL, 10);
	if (declared > NET_MAX_BODY) {
		*status = 413;
		return NULL;
	}
	uint8_t* body = malloc(declared ? (size_t) declared : 1);
	size_t have = extraLength < declared ? extraLength : (size_t) declared;
	memcpy(body, extra, have);
	if (!readAll(fd, body + have, (size_t) declared - have)) {
		free(body);
		*status = 400;
		return NULL;
	}
	*length = (size_t) declared;
	return body;
}

static void* clientThread(void* arg) {
	struct Client* client = arg;
	int fd = client->fd;
	char request[MAX_REQUEST + 1];
	size_t used = 0;
	char* end = NULL;
	while (used < MAX_REQUEST) {
		ssize_t n = read(fd, request + used, MAX_REQUEST - used);
		if (n <= 0) {
			break;
		}
		used += (size_t) n;
		request[used] = '\0';
		if ((end = strstr(request, "\r\n\r\n"))) {
			break;
		}
	}
	request[used] = '\0';

	char method[8];
	char path[1024];
	if (!end || sscanf(request, "%7s %1023s", method, path) != 2 || path[0] != '/') {
		sendStatus(fd, "400 Bad Request");
		goto done;
	}
	end += 4;
	size_t extra = used - (size_t) (end - request);
	end[-2] = '\0'; /* headers stay a C string; the body starts at end */

	char upgradeHeader[32];
	if (!strcmp(method, "GET") && findHeader(request, "Upgrade", upgradeHeader, sizeof(upgradeHeader)) &&
	    !strcasecmp(upgradeHeader, "websocket")) {
		upgrade(client->server, fd, request, path);
		goto done;
	}

	int status = 0;
	size_t length = 0;
	uint8_t* body = readBody(fd, request, end, extra, &length, &status);
	if (status) {
		struct HttpResponse error = { .status = status };
		sendResponse(fd, &error);
		goto done;
	}
	struct HttpResponse response = { .status = 200 };
	if (client->server->http &&
	    client->server->http(method, path, body ? body : (const uint8_t*) "", length, &response, client->server->context)) {
		sendResponse(fd, &response);
		free(response.body);
	} else if (!strcmp(method, "GET")) {
		serveFile(client->server, fd, path);
	} else {
		sendStatus(fd, "404 Not Found");
	}
	free(body);

done:
	close(fd);
	free(client);
	return NULL;
}

bool netServe(int port, const char* webDir, HttpHandler http, WsHandler handler, void* context) {
	static struct Server server;
	server.webDir = webDir;
	server.http = http;
	server.handler = handler;
	server.context = context;

	int listener = socket(AF_INET, SOCK_STREAM, 0);
	if (listener < 0) {
		perror("socket");
		return false;
	}
	int yes = 1;
	setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
	struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons((uint16_t) port), .sin_addr.s_addr = htonl(INADDR_ANY) };
	if (bind(listener, (struct sockaddr*) &address, sizeof(address)) < 0 || listen(listener, 16) < 0) {
		perror("listen");
		close(listener);
		return false;
	}

	for (;;) {
		int fd = accept(listener, NULL, NULL);
		if (fd < 0) {
			if (errno == EINTR) {
				continue;
			}
			perror("accept");
			return false;
		}
		/* Frames are small and latency matters more than packing. */
		setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof(yes));
		struct Client* client = malloc(sizeof(*client));
		client->server = &server;
		client->fd = fd;
		pthread_t thread;
		if (pthread_create(&thread, NULL, clientThread, client) != 0) {
			close(fd);
			free(client);
			continue;
		}
		pthread_detach(thread);
	}
}

static bool sendFrame(struct WsConn* conn, int opcode, const void* head, size_t headLen, const void* body, size_t bodyLen) {
	size_t length = headLen + bodyLen;
	uint8_t header[10];
	size_t headerLength = 2;
	header[0] = (uint8_t) (0x80 | opcode);
	if (length < 126) {
		header[1] = (uint8_t) length;
	} else if (length <= 0xFFFF) {
		header[1] = 126;
		header[2] = (uint8_t) (length >> 8);
		header[3] = (uint8_t) length;
		headerLength = 4;
	} else {
		header[1] = 127;
		for (int i = 0; i < 8; ++i) {
			header[2 + i] = (uint8_t) ((uint64_t) length >> (56 - 8 * i));
		}
		headerLength = 10;
	}
	struct iovec parts[3] = {
		{ header, headerLength },
		{ (void*) head, headLen },
		{ (void*) body, bodyLen },
	};
	pthread_mutex_lock(&conn->writeLock);
	bool ok = true;
	size_t total = headerLength + length;
	int index = 0;
	while (total && ok) {
		ssize_t n = writev(conn->fd, parts + index, 3 - index);
		if (n < 0 && errno == EINTR) {
			continue;
		}
		if (n <= 0) {
			ok = false;
			break;
		}
		total -= (size_t) n;
		while (n > 0 && index < 3) {
			if ((size_t) n >= parts[index].iov_len) {
				n -= (ssize_t) parts[index].iov_len;
				parts[index].iov_len = 0;
				++index;
			} else {
				parts[index].iov_base = (uint8_t*) parts[index].iov_base + n;
				parts[index].iov_len -= (size_t) n;
				n = 0;
			}
		}
	}
	pthread_mutex_unlock(&conn->writeLock);
	return ok;
}

void wsShutdown(struct WsConn* conn) {
	shutdown(conn->fd, SHUT_RDWR);
}

bool wsSend(struct WsConn* conn, const void* head, size_t headLen, const void* body, size_t bodyLen) {
	return sendFrame(conn, WS_BINARY, head, headLen, body, bodyLen);
}

int wsRead(struct WsConn* conn, uint8_t* buf, size_t capacity, size_t* length) {
	for (;;) {
		uint8_t header[2];
		if (!readAll(conn->fd, header, 2)) {
			return -1;
		}
		int opcode = header[0] & 0x0F;
		bool fin = header[0] & 0x80;
		bool masked = header[1] & 0x80;
		uint64_t size = header[1] & 0x7F;
		if (size == 126) {
			uint8_t extended[2];
			if (!readAll(conn->fd, extended, 2)) {
				return -1;
			}
			size = ((uint64_t) extended[0] << 8) | extended[1];
		} else if (size == 127) {
			uint8_t extended[8];
			if (!readAll(conn->fd, extended, 8)) {
				return -1;
			}
			size = 0;
			for (int i = 0; i < 8; ++i) {
				size = (size << 8) | extended[i];
			}
		}
		/* Clients must mask; linkd's messages are tiny and never fragmented. */
		if (!masked || !fin || size > capacity) {
			return -1;
		}
		uint8_t mask[4];
		if (!readAll(conn->fd, mask, 4) || !readAll(conn->fd, buf, (size_t) size)) {
			return -1;
		}
		for (uint64_t i = 0; i < size; ++i) {
			buf[i] ^= mask[i & 3];
		}

		switch (opcode) {
		case WS_BINARY:
		case WS_TEXT:
			*length = (size_t) size;
			return opcode;
		case WS_PING:
			sendFrame(conn, WS_PONG, buf, (size_t) size, NULL, 0);
			break;
		case WS_PONG:
			break;
		default:
			sendFrame(conn, WS_CLOSE, NULL, 0, NULL, 0);
			return -1;
		}
	}
}
