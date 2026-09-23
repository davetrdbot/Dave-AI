import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;

import '../api/client.dart';
import '../api/models.dart';
import '../session.dart';
import '../theme.dart';

/// Trade notifications WITHOUT Firebase.
///
/// Researched before building. On Android the Firebase-free options are UnifiedPush -- which needs
/// the trader to install a separate distributor app such as ntfy, or whose "embedded" mode routes
/// through Google Play services, i.e. FCM again -- or the app holding its OWN connection to the
/// trader's own server. This is the second: a foreground service keeps a Server-Sent Events stream
/// open to /api/app/events on the Railway deployment and raises a local notification per trade.
/// Nothing extra to install, no third party.
///
/// Two decisions that are easy to get wrong and would each have broken it quietly:
///
///   - The service type is `remoteMessaging` and NOTHING else. The obvious choice, `dataSync`
///     (it is even in this plugin's own README example), is capped at 6 hours per 24 on Android 15
///     and may not be started from BOOT_COMPLETED -- the stream would die mid-afternoon and never
///     come back after a reboot. remoteMessaging has neither limit. See AndroidManifest.xml.
///   - Android WILL still kill this sometimes (Doze, aggressive OEM battery managers). So every
///     start first catches up on what it missed via `?format=json&after=<last id>`, and the stream
///     resumes with Last-Event-ID. A fill that happened while the phone was asleep arrives late
///     rather than never.

const _tradeChannelId = 'dave_trades';
const _serviceChannelId = 'dave_connection';
const _serviceId = 7300;

/// Watchdog: the server sends a heartbeat comment every 25s. Silence for longer than this means
/// the socket is dead even if nothing has told us so -- a half-open TCP connection on mobile
/// data can sit "connected" for many minutes delivering nothing.
const _silenceLimit = Duration(seconds: 70);

/// More missed trades than this after a long sleep becomes ONE summary notification instead of a
/// burst of pings the trader has to swipe away one by one.
const _maxIndividualCatchUp = 3;

@pragma('vm:entry-point')
void startCallback() {
  FlutterForegroundTask.setTaskHandler(TradeStreamHandler());
}

/// The words on a notification. Pure, so it is tested without a device.
///
/// No emoji anywhere -- the design direction is Apple's, and a trade alert reads as a fact.
({String title, String body}) describeTradeEvent(TradeEvent e) {
  if (e.isOpen) {
    final side = e.isBuy == null ? '' : (e.isBuy! ? ' buy' : ' sell');
    final parts = <String>[
      if (e.lots != null) '${_lots(e.lots!)} lots',
      if (e.openPrice != null) 'at ${formatPrice(e.openPrice!)}',
    ];
    final levels = <String>[
      if (e.sl != null) 'SL ${formatPrice(e.sl!)}',
      if (e.tp != null) 'TP ${formatPrice(e.tp!)}',
    ];
    final body = [if (parts.isNotEmpty) parts.join(' '), ...levels].join('  ·  ');
    return (title: '${e.symbol}$side opened', body: body.isEmpty ? 'New position' : body);
  }
  final result = e.pnl == null ? '' : ' ${formatMoney(e.pnl!, signed: true)}';
  final why = switch (e.reason) {
    'tp' => 'Take profit hit',
    'sl' => 'Stop loss hit',
    'dave' => 'Closed by Dave',
    'manual' => 'Closed in MT5',
    _ => 'Position closed',
  };
  return (title: '${e.symbol} closed$result', body: why);
}

String _lots(double v) => v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toString();

/// The summary for a long gap, so ten missed fills are one notification, not ten.
({String title, String body}) describeCatchUp(List<TradeEvent> events) {
  final opened = events.where((e) => e.isOpen).length;
  final closed = events.length - opened;
  final pnl = events.where((e) => !e.isOpen && e.pnl != null).fold<double>(0, (s, e) => s + e.pnl!);
  final parts = [if (opened > 0) '$opened opened', if (closed > 0) '$closed closed'];
  final body = closed > 0 ? '${parts.join(', ')}  ·  ${formatMoney(pnl, signed: true)} realised' : parts.join(', ');
  return (title: '${events.length} trades while you were away', body: body);
}

/// Parses a Server-Sent Events byte stream into (event, data, id) frames.
///
/// Hand-written rather than a package because the format is small and fully specified, and the
/// parts that matter here -- multi-line data, comment lines as heartbeats, blank-line dispatch --
/// are exactly the parts a stricter library would hide from the watchdog.
class SseFrame {
  SseFrame(this.event, this.data, this.id);
  final String event;
  final String data;
  final String? id;
}

class SseParser {
  String _event = 'message';
  final _data = <String>[];
  String? _id;

  /// Feeds one line (without its line ending). Returns a frame when a blank line completes one.
  SseFrame? addLine(String line) {
    if (line.isEmpty) {
      if (_data.isEmpty) {
        _event = 'message';
        return null;
      }
      final frame = SseFrame(_event, _data.join('\n'), _id);
      _event = 'message';
      _data.clear();
      return frame;
    }
    if (line.startsWith(':')) return null; // comment -- the server's heartbeat
    final colon = line.indexOf(':');
    final field = colon == -1 ? line : line.substring(0, colon);
    var value = colon == -1 ? '' : line.substring(colon + 1);
    if (value.startsWith(' ')) value = value.substring(1);
    switch (field) {
      case 'event':
        _event = value;
      case 'data':
        _data.add(value);
      case 'id':
        _id = value;
    }
    return null;
  }
}

class TradeStreamHandler extends TaskHandler {
  final _notifications = FlutterLocalNotificationsPlugin();
  http.Client? _client;
  bool _stopped = false;
  bool _connected = false;
  DateTime _lastByte = DateTime.now();

  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {
    await _notifications.initialize(
      settings: const InitializationSettings(android: AndroidInitializationSettings('@mipmap/ic_launcher')),
    );
    await _notifications
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(const AndroidNotificationChannel(
          _tradeChannelId,
          'Trades',
          description: 'A trade opened or closed.',
          importance: Importance.high,
        ));
    unawaited(_run());
  }

  /// Runs every 30s (see ForegroundTaskOptions). Only job: notice a silently dead socket.
  @override
  void onRepeatEvent(DateTime timestamp) {
    if (_connected && DateTime.now().difference(_lastByte) > _silenceLimit) {
      // Closing the client makes the in-flight read throw, which the run loop treats as a drop
      // and reconnects -- with Last-Event-ID, so nothing sent in the meantime is lost.
      _client?.close();
    }
  }

  @override
  Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {
    _stopped = true;
    _client?.close();
  }

  Future<void> _run() async {
    var backoff = const Duration(seconds: 5);
    while (!_stopped) {
      final session = await Session.load();
      if (session == null) {
        await FlutterForegroundTask.updateService(notificationTitle: 'Dave', notificationText: 'Not connected. Open Dave to pair this phone.');
        return;
      }
      final api = DaveApi(base: session.endpoint, token: session.token);
      try {
        await _catchUp(api);
        final hadConnection = await _stream(session);
        if (hadConnection) backoff = const Duration(seconds: 5);
      } on UnpairedException catch (e) {
        // Retrying cannot fix a revoked phone. Forget the credential, say so, and stop -- rather
        // than hammering the server every few seconds forever with a token it has already refused.
        await Session.clear(reason: e.message);
        await FlutterForegroundTask.updateService(notificationTitle: 'Dave', notificationText: 'This phone was disconnected. Open Dave to pair it again.');
        await FlutterForegroundTask.stopService();
        return;
      } catch (e) {
        debugPrint('[dave-push] connection error: $e');
      } finally {
        api.close();
        _connected = false;
      }
      if (_stopped) return;
      await FlutterForegroundTask.updateService(notificationTitle: 'Dave', notificationText: 'Reconnecting…');
      await Future<void>.delayed(backoff);
      backoff = Duration(seconds: math.min(backoff.inSeconds * 2, 60));
    }
  }

  /// Delivers whatever happened while nothing was listening.
  Future<void> _catchUp(DaveApi api) async {
    final last = await Session.lastEventId();
    // No saved position means this phone has never listened before. Everything in the log is
    // history from before it was paired -- announcing it would be a burst of stale alerts. The
    // stream's "ready" frame sets the starting point instead.
    if (last == null) return;
    final result = await api.eventsAfter(last);
    if (result.events.isEmpty) return;
    if (result.events.length > _maxIndividualCatchUp) {
      final s = describeCatchUp(result.events);
      await _show(result.events.last.id, s.title, s.body);
    } else {
      for (final e in result.events) {
        final d = describeTradeEvent(e);
        await _show(e.id, d.title, d.body);
      }
    }
    await Session.setLastEventId(result.latestId);
  }

  /// Holds the stream until it drops. Returns whether it ever connected.
  Future<bool> _stream(Session session) async {
    final client = http.Client();
    _client = client;
    final last = await Session.lastEventId();
    final req = http.Request('GET', session.endpoint.replace(path: '/api/app/events'))
      ..headers.addAll({
        'authorization': 'Bearer ${session.token}',
        'accept': 'text/event-stream',
        'cache-control': 'no-cache',
        if (last != null) 'last-event-id': '$last',
      });

    final res = await client.send(req).timeout(const Duration(seconds: 20));
    if (res.statusCode == 401) throw const UnpairedException();
    if (res.statusCode != 200) throw ApiException('Event stream refused (${res.statusCode}).', statusCode: res.statusCode);

    _connected = true;
    _lastByte = DateTime.now();
    await FlutterForegroundTask.updateService(notificationTitle: 'Dave', notificationText: 'Watching for trades');

    final parser = SseParser();
    await for (final line in res.stream.transform(utf8.decoder).transform(const LineSplitter())) {
      _lastByte = DateTime.now();
      final frame = parser.addLine(line);
      if (frame != null) await _dispatch(frame);
      if (_stopped) break;
    }
    return true;
  }

  Future<void> _dispatch(SseFrame frame) async {
    Map<String, dynamic> data;
    try {
      final v = jsonDecode(frame.data);
      if (v is! Map) return;
      data = Map<String, dynamic>.from(v);
    } catch (_) {
      return; // a malformed frame is skipped, never fatal to the stream
    }
    if (frame.event == 'ready') {
      if (await Session.lastEventId() == null && data['latestId'] is num) {
        await Session.setLastEventId((data['latestId'] as num).toInt());
      }
      return;
    }
    if (frame.event == 'trade') {
      final e = TradeEvent.fromJson(data);
      final d = describeTradeEvent(e);
      await _show(e.id, d.title, d.body);
      await Session.setLastEventId(e.id);
    }
  }

  Future<void> _show(int id, String title, String body) => _notifications.show(
        id: id & 0x7fffffff,
        title: title,
        body: body,
        notificationDetails: const NotificationDetails(
          android: AndroidNotificationDetails(
            _tradeChannelId,
            'Trades',
            channelDescription: 'A trade opened or closed.',
            importance: Importance.high,
            priority: Priority.high,
            category: AndroidNotificationCategory.message,
          ),
        ),
      );
}

/// The app's side: start, stop and ask for what the service needs.
class PushService {
  static void initPort() => FlutterForegroundTask.initCommunicationPort();

  static void _init() {
    FlutterForegroundTask.init(
      androidNotificationOptions: AndroidNotificationOptions(
        channelId: _serviceChannelId,
        channelName: 'Connection',
        channelDescription: 'Keeps Dave connected so trade alerts arrive instantly. Android requires this to be visible.',
        channelImportance: NotificationChannelImportance.LOW,
        priority: NotificationPriority.LOW,
        onlyAlertOnce: true,
      ),
      iosNotificationOptions: const IOSNotificationOptions(showNotification: false, playSound: false),
      foregroundTaskOptions: ForegroundTaskOptions(
        eventAction: ForegroundTaskEventAction.repeat(30000),
        autoRunOnBoot: true,
        autoRunOnMyPackageReplaced: true,
        allowWakeLock: true,
        allowWifiLock: true,
      ),
    );
  }

  /// Notifications permission (Android 13+). Returns whether it is granted.
  static Future<bool> requestNotificationPermission() async {
    if (await FlutterForegroundTask.checkNotificationPermission() != NotificationPermission.granted) {
      await FlutterForegroundTask.requestNotificationPermission();
    }
    return await FlutterForegroundTask.checkNotificationPermission() == NotificationPermission.granted;
  }

  static Future<bool> get isIgnoringBatteryOptimizations => FlutterForegroundTask.isIgnoringBatteryOptimizations;
  static Future<bool> requestIgnoreBatteryOptimization() => FlutterForegroundTask.requestIgnoreBatteryOptimization();

  static Future<bool> get isRunning => FlutterForegroundTask.isRunningService;

  static Future<bool> start() async {
    _init();
    final ServiceRequestResult result;
    if (await FlutterForegroundTask.isRunningService) {
      result = await FlutterForegroundTask.restartService();
    } else {
      result = await FlutterForegroundTask.startService(
        serviceId: _serviceId,
        // remoteMessaging ONLY -- see the file header for why never dataSync.
        serviceTypes: [ForegroundServiceTypes.remoteMessaging],
        notificationTitle: 'Dave',
        notificationText: 'Connecting…',
        callback: startCallback,
      );
    }
    return result is ServiceRequestSuccess;
  }

  static Future<void> stop() async {
    if (await FlutterForegroundTask.isRunningService) await FlutterForegroundTask.stopService();
  }
}
