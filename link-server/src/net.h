/*
 * A small HTTP + WebSocket server for linkd: requests with bodies go to a
 * callback, GETs it doesn't answer are served from one directory, and
 * WebSocket upgrades are handed to another callback on their own thread.
 * Only what linkd needs (binary messages, ping/pong, close); not a general
 * purpose server.
 */
#ifndef LINKD_NET_H
#define LINKD_NET_H

#include <pthread.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

struct WsConn {
	int fd;
	pthread_mutex_t writeLock;
};

enum WsOpcode {
	WS_TEXT = 0x1,
	WS_BINARY = 0x2,
	WS_CLOSE = 0x8,
	WS_PING = 0x9,
	WS_PONG = 0xA,
};

/* Called on the connection's thread with the request path (including the
 * query string). The connection is closed when it returns. */
typedef void (*WsHandler)(struct WsConn* conn, const char* path, void* context);

struct HttpResponse {
	int status;
	const char* contentType;
	uint8_t* body; /* malloc'd, freed by the server; may be NULL */
	size_t length;
};

/* Called for every non-WebSocket request. Returns false to fall through to
 * the static files (GET only). */
typedef bool (*HttpHandler)(const char* method, const char* path, const uint8_t* body, size_t length,
                            struct HttpResponse* response, void* context);

/* Largest request body accepted (a 32 MB ROM plus some room). */
#define NET_MAX_BODY (33u * 1024 * 1024)

/* Listens on port and serves forever (until the process exits). */
bool netServe(int port, const char* webDir, HttpHandler http, WsHandler ws, void* context);

/* Closes the socket under a WebSocket so its wsRead returns. */
void wsShutdown(struct WsConn* conn);

/* Sends one binary message made of a head and a body (either may be empty).
 * Safe to call from several threads. */
bool wsSend(struct WsConn* conn, const void* head, size_t headLen, const void* body, size_t bodyLen);

/* Reads the next data message into buf. Answers pings itself. Returns the
 * opcode (WS_BINARY or WS_TEXT), or -1 when the connection closed or broke. */
int wsRead(struct WsConn* conn, uint8_t* buf, size_t capacity, size_t* length);

#endif
