# opusic-sys builds bundled Opus via CMake. During macOS -> Linux cross builds,
# host /usr/bin/ranlib silently rewrites the ELF archive without its objects.
# Keep CMake's archive creation on Bazel's target archiver instead.
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR "$ENV{CARGO_CFG_TARGET_ARCH}")
# cmake-rs passes the target LLVM archiver through AR; make CMake use it for
# archive creation. LLVM ar indexes `qc` archives itself, so no separate ranlib
# is needed (the macOS host's ranlib destroys the ELF archive).
get_filename_component(_execroot "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
get_filename_component(_archiver "$ENV{AR}" ABSOLUTE BASE_DIR "${_execroot}")
set(CMAKE_AR "${_archiver}" CACHE FILEPATH "Target archiver" FORCE)
set(CMAKE_RANLIB "/usr/bin/true" CACHE FILEPATH "LLVM ar already writes the index" FORCE)
