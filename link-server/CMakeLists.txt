cmake_minimum_required(VERSION 3.16)
project(linkd C)

# Path to an mGBA source tree built with -DBUILD_STATIC=ON (see build.sh).
set(MGBA_DIR "" CACHE PATH "mGBA source directory")
set(MGBA_BUILD_DIR "${MGBA_DIR}/build" CACHE PATH "mGBA build directory")

find_package(ZLIB REQUIRED)
find_package(PNG REQUIRED)
find_package(Threads REQUIRED)

add_executable(linkd src/linkd.c src/net.c)
set_property(TARGET linkd PROPERTY C_STANDARD 11)
target_include_directories(linkd PRIVATE
	"${MGBA_DIR}/include"
	"${MGBA_BUILD_DIR}/include")
# mGBA passes these on its compiler command line rather than in flags.h, and
# ENABLE_DIRECTORIES changes the layout of struct mCore, so they must match
# the library's build.
target_compile_definitions(linkd PRIVATE BUILD_STATIC ENABLE_DIRECTORIES ENABLE_VFS ENABLE_VFS_FD)
target_link_libraries(linkd PRIVATE
	"${MGBA_BUILD_DIR}/libmgba.a"
	PNG::PNG ZLIB::ZLIB Threads::Threads m)
if(APPLE)
	target_compile_definitions(linkd PRIVATE _DARWIN_C_SOURCE)
	# mGBA's config code looks up the app bundle on macOS.
	target_link_libraries(linkd PRIVATE "-framework CoreFoundation")
else()
	# mGBA's threading header uses pthread_setname_np, which glibc hides
	# without it.
	target_compile_definitions(linkd PRIVATE _GNU_SOURCE)
endif()
