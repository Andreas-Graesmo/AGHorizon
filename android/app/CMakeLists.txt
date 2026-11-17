cmake_minimum_required(VERSION 3.18.1)
project(aghorizon)

# The small piece of native code that starts Node.js (libnode.so, from the nodejs-mobile project) inside the app.
add_library(node-bridge SHARED src/main/cpp/node-bridge.cpp)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/libnode/bin/${ANDROID_ABI}/libnode.so)

target_link_libraries(node-bridge libnode log)
