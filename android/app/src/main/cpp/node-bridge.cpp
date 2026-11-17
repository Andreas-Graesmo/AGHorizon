// Starts Node.js (libnode.so from the nodejs-mobile project) inside the app's process and sends what it prints to logcat.
#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>

// From libnode.so (node.h): runs Node until its event loop ends. Declared here so the build needs no Node headers.
namespace node { int Start(int argc, char* argv[]); }

static const char* TAG = "AGHorizonNode";
static int pipeOut[2];
static int pipeErr[2];

static void* pump(void* arg) {
  const int fd = static_cast<int>(reinterpret_cast<intptr_t>(arg));
  const int prio = fd == pipeErr[0] ? ANDROID_LOG_ERROR : ANDROID_LOG_INFO;
  char buf[2048];
  ssize_t n;
  while ((n = read(fd, buf, sizeof buf - 1)) > 0) {
    if (buf[n - 1] == '\n') --n;
    buf[n] = 0;
    __android_log_write(prio, TAG, buf);
  }
  return nullptr;
}

static void redirectOutput() {
  setvbuf(stdout, nullptr, _IONBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  if (pipe(pipeOut) != 0 || pipe(pipeErr) != 0) return;
  dup2(pipeOut[1], STDOUT_FILENO);
  dup2(pipeErr[1], STDERR_FILENO);
  pthread_t t;
  if (pthread_create(&t, nullptr, pump, reinterpret_cast<void*>(static_cast<intptr_t>(pipeOut[0]))) == 0) pthread_detach(t);
  if (pthread_create(&t, nullptr, pump, reinterpret_cast<void*>(static_cast<intptr_t>(pipeErr[0]))) == 0) pthread_detach(t);
}

extern "C" JNIEXPORT jint JNICALL
Java_app_aghorizon_tv_NodeServer_startNode(JNIEnv* env, jobject /* this */, jobjectArray arguments) {
  // libuv wants every argument in one block of memory, one after the other
  const jsize argc = env->GetArrayLength(arguments);
  std::vector<std::string> args;
  size_t total = 0;
  for (jsize i = 0; i < argc; i++) {
    auto js = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
    const char* s = env->GetStringUTFChars(js, nullptr);
    args.emplace_back(s);
    env->ReleaseStringUTFChars(js, s);
    env->DeleteLocalRef(js);
    total += args.back().size() + 1;
  }
  char* block = static_cast<char*>(calloc(total, 1));
  std::vector<char*> argv;
  char* at = block;
  for (const auto& a : args) {
    memcpy(at, a.c_str(), a.size() + 1);
    argv.push_back(at);
    at += a.size() + 1;
  }
  redirectOutput();
  const int code = node::Start(static_cast<int>(argv.size()), argv.data());
  free(block);
  return code;
}
