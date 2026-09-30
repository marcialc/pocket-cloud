/*
 * A tiny GBA ROM that talks over the link cable in multiplayer mode, so
 * linkd can be checked without a commercial game or a save.
 *
 * Every frame the parent (player 0) starts a transfer; each GBA sends a word
 * tagged with its role (0x1xxx parent, 0x2xxx child) and the frame count.
 * What arrived is written to the start of EWRAM for linkd to read, and the
 * backdrop colour shows the other GBA's word.
 *
 * Built by make-rom.sh with the system clang; no GBA toolchain needed.
 */

#include <stdint.h>

#define REG16(addr) (*(volatile uint16_t*) (addr))

#define REG_DISPCNT REG16(0x04000000)
#define REG_VCOUNT REG16(0x04000006)
#define REG_SIOMULTI0 REG16(0x04000120)
#define REG_SIOMULTI1 REG16(0x04000122)
#define REG_SIOCNT REG16(0x04000128)
#define REG_SIOMLT_SEND REG16(0x0400012A)
#define REG_RCNT REG16(0x04000134)
#define BACKDROP REG16(0x05000000)

#define SIOCNT_BAUD_115200 0x0003
#define SIOCNT_SI 0x0004
#define SIOCNT_START 0x0080
#define SIOCNT_MULTI 0x2000

/* Read by linkd; keep in sync with RESULT_* in src/linkd.c. */
#define RESULT ((volatile uint16_t*) 0x02000000)
enum { RESULT_MAGIC, RESULT_PARENT, RESULT_ID, RESULT_MULTI0, RESULT_MULTI1, RESULT_TRANSFERS, RESULT_FRAME };

/* Entry point at 0x08000000, then the header up to 0xC0. mGBA only checks
 * the branch (byte 3 = 0xEA) and the fixed 0x96 at 0xB2. */
__asm__(
	".text\n"
	".arm\n"
	"b main\n"
	".fill 0xB2 - 4, 1, 0\n"
	".byte 0x96\n"
	".fill 0xC0 - 0xB3, 1, 0\n");

__attribute__((used, noreturn)) static void main(void) {
	uint16_t frame = 0;
	uint16_t transfers = 0;

	REG_DISPCNT = 0; /* no layers, so the whole screen is the backdrop */
	REG_RCNT = 0;
	REG_SIOCNT = SIOCNT_MULTI | SIOCNT_BAUD_115200;

	for (;;) {
		while (REG_VCOUNT >= 160) {}
		while (REG_VCOUNT < 160) {}
		++frame;

		uint16_t siocnt = REG_SIOCNT;
		int parent = !(siocnt & SIOCNT_SI);
		REG_SIOMLT_SEND = (parent ? 0x1000 : 0x2000) | (frame & 0x0FFF);
		if (parent) {
			REG_SIOCNT = siocnt | SIOCNT_START;
			while (REG_SIOCNT & SIOCNT_START) {}
			++transfers;
		}

		uint16_t multi0 = REG_SIOMULTI0;
		uint16_t multi1 = REG_SIOMULTI1;
		RESULT[RESULT_MAGIC] = 0x4C4B; /* "LK" */
		RESULT[RESULT_PARENT] = parent;
		RESULT[RESULT_ID] = (REG_SIOCNT >> 4) & 3;
		RESULT[RESULT_MULTI0] = multi0;
		RESULT[RESULT_MULTI1] = multi1;
		RESULT[RESULT_TRANSFERS] = transfers;
		RESULT[RESULT_FRAME] = frame;
		BACKDROP = (parent ? multi1 : multi0) & 0x7FFF;
	}
}
