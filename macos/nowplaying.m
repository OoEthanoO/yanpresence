// What macOS's system Now Playing says TV.app is playing, one JSON object per line on stdout.
//
// Why this exists: TV.app answers Apple Events with `player state` "stopped" and no `current track` while it
// streams (every Apple TV+ title, rental and purchase played from the cloud), so scripts/tv-watch.js sees
// nothing. The system Now Playing record does have the title, the show, the duration and the position.
//
// Why it is a library loaded into /usr/bin/perl: since macOS 15.4 the MediaRemote calls that read Now Playing
// only answer processes Apple signed. /usr/bin/perl is one. It loads this library with DynaLoader, then calls
// yp_nowplaying_watch() as an XSUB; that never returns, so perl stays parked in it and its loop is the watcher.
//
// The loop must not run in a constructor. It did at first, and only the first request of a process was ever
// answered: mediaremoted replied to every one within milliseconds (its log says so), but a constructor runs
// while dyld holds its loader lock, and delivering the replies needs that lock. Called after loading, every
// request is answered in a few hundredths of a second.
//
//   /usr/bin/perl -e 'require DynaLoader; my $l = DynaLoader::dl_load_file($ARGV[0], 0) or die DynaLoader::dl_error();
//     DynaLoader::dl_install_xsub("main::watch", DynaLoader::dl_find_symbol($l, "yp_nowplaying_watch") or die);
//     main::watch()' yanpresence-nowplaying.dylib
//
// Lines, in the shape src/nowplaying.js reads:
//   {"state":"watcher-ready", ...}                         once, at start
//   {"state":"none","bundle":"com.apple.Music"}            something other than TV.app owns Now Playing
//   {"state":"none"}                                       nothing does
//   {"state":"playing"|"paused","bundle":"com.apple.TV","title":...,"album":...,"artist":...,
//    "duration":s,"position":s,"mediaType":...,"contentId":...}
//
// Environment: YP_POLL_MS (default 1000), YP_IDLE_POLL_MS (default 5000, used while TV.app is not the player).
// Build: clang -dynamiclib -fobjc-arc -framework AppKit -arch arm64 -arch x86_64 -o yanpresence-nowplaying.dylib
#import <AppKit/AppKit.h>
#include <dlfcn.h>
#include <signal.h>
#include <stdio.h>
#include <unistd.h>

typedef void (*GetInfoFn)(dispatch_queue_t, void (^)(NSDictionary *));
typedef void (*GetPidFn)(dispatch_queue_t, void (^)(int));

static NSString *const kTVBundle = @"com.apple.TV";

static void emit(NSDictionary *object) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  if (!data) return;
  // A closed pipe means the parent is gone: SIGPIPE (left at its default) ends the process here.
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static long envMs(const char *name, long fallback) {
  const char *raw = getenv(name);
  if (!raw) return fallback;
  long v = strtol(raw, NULL, 10);
  return v >= 200 ? v : fallback;
}

static id string(id v) { return [v isKindOfClass:[NSString class]] ? v : @""; }
static double number(id v) { return [v respondsToSelector:@selector(doubleValue)] ? [v doubleValue] : 0.0; }

// One look at Now Playing. Waits at most two seconds for each answer.
static NSDictionary *snapshot(GetPidFn getPid, GetInfoFn getInfo) {
  dispatch_queue_t q = dispatch_get_global_queue(QOS_CLASS_UTILITY, 0);
  __block int pid = 0;
  dispatch_semaphore_t s1 = dispatch_semaphore_create(0);
  getPid(q, ^(int p) { pid = p; dispatch_semaphore_signal(s1); });
  if (dispatch_semaphore_wait(s1, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC))) return @{@"state": @"none"};
  if (pid <= 0) return @{@"state": @"none"};

  NSString *bundle = [NSRunningApplication runningApplicationWithProcessIdentifier:pid].bundleIdentifier ?: @"";
  if (![bundle isEqualToString:kTVBundle]) return @{@"state": @"none", @"bundle": bundle};

  __block NSDictionary *info = nil;
  dispatch_semaphore_t s2 = dispatch_semaphore_create(0);
  getInfo(q, ^(NSDictionary *i) { info = i; dispatch_semaphore_signal(s2); });
  if (dispatch_semaphore_wait(s2, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) || !info) {
    return @{@"state": @"none", @"bundle": bundle};
  }

  double rate = number(info[@"kMRMediaRemoteNowPlayingInfoPlaybackRate"]);
  // TV.app leaves PlaybackRate at 1 when it pauses and only clears this flag, so the flag decides when it is
  // there; the rate is the fallback for an app that sets no flag.
  id flag = info[@"kMRMediaRemoteNowPlayingApplicationIsPlayingUserInfoKey"];
  BOOL playing = [flag respondsToSelector:@selector(boolValue)] ? [flag boolValue] : rate > 0;
  double elapsed = number(info[@"kMRMediaRemoteNowPlayingInfoElapsedTime"]);
  id stamp = info[@"kMRMediaRemoteNowPlayingInfoTimestamp"];
  // ElapsedTime is as of Timestamp; while playing, the clock has moved on since. Paused, it has not.
  if (playing && rate > 0 && [stamp isKindOfClass:[NSDate class]]) {
    elapsed += -[(NSDate *)stamp timeIntervalSinceNow] * rate;
  }

  NSString *title = string(info[@"kMRMediaRemoteNowPlayingInfoTitle"]);
  if (!title.length) return @{@"state": @"none", @"bundle": bundle};

  return @{
    @"state": playing ? @"playing" : @"paused",
    @"bundle": bundle,
    @"title": title,
    @"album": string(info[@"kMRMediaRemoteNowPlayingInfoAlbum"]),
    @"artist": string(info[@"kMRMediaRemoteNowPlayingInfoArtist"]),
    @"duration": @(number(info[@"kMRMediaRemoteNowPlayingInfoDuration"])),
    @"position": @(MAX(0.0, elapsed)),
    @"mediaType": string(info[@"kMRMediaRemoteNowPlayingInfoMediaType"]),
    @"contentId": string(info[@"kMRMediaRemoteNowPlayingInfoContentItemIdentifier"]),
  };
}

// Called by perl as an XSUB, whose arguments (the interpreter and the CV) are not needed. Never returns.
__attribute__((visibility("default"))) void yp_nowplaying_watch(void *interpreter, void *cv) {
  (void)interpreter;
  (void)cv;
  signal(SIGPIPE, SIG_DFL);
  void *mr = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote", RTLD_NOW);
  GetInfoFn getInfo = mr ? (GetInfoFn)dlsym(mr, "MRMediaRemoteGetNowPlayingInfo") : NULL;
  GetPidFn getPid = mr ? (GetPidFn)dlsym(mr, "MRMediaRemoteGetNowPlayingApplicationPID") : NULL;
  if (!getInfo || !getPid) {
    emit(@{@"state": @"error", @"error": @"MediaRemote is not available on this macOS"});
    _exit(3);
  }

  long busyMs = envMs("YP_POLL_MS", 1000);
  long idleMs = MAX(envMs("YP_IDLE_POLL_MS", 5000), busyMs);
  pid_t parent = getppid();
  emit(@{@"state": @"watcher-ready", @"intervalMs": @(busyMs), @"idleMs": @(idleMs)});

  for (;;) {
    long sleepMs;
    @autoreleasepool {
      NSDictionary *s = snapshot(getPid, getInfo);
      emit(s);
      sleepMs = [s[@"bundle"] isEqual:kTVBundle] ? busyMs : idleMs;
    }
    usleep((useconds_t)(sleepMs * 1000));
    if (getppid() != parent) _exit(0);  // orphaned: the app that started us is gone
  }
}
