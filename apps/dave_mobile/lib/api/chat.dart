import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:http/http.dart' as http;

import '../push/push_service.dart' show SseParser;
import 'client.dart';

/// Talking to Dave from the phone: /api/app/chat/* on the bot process itself (not the admin
/// panel), because only the process running Dave can show his steps as they happen and really
/// stop him. Same device token as every other app call.

/// One thing that happened: a step of a chat turn, a loop decision, a Nous card...
class ActivityEvent {
  ActivityEvent({required this.id, required this.at, required this.feed, required this.kind, required this.data, this.turnId, this.channel, this.agent});

  final int id;
  final DateTime at;

  /// chat, loop or background.
  final String feed;
  final String kind;
  final String? turnId;

  /// app or telegram -- where a chat turn came from.
  final String? channel;

  /// Who did it when it wasn't Dave himself: worker:NAME, flo, journal, nous, thinking.
  final String? agent;
  final Map<String, dynamic> data;

  factory ActivityEvent.fromJson(Map<String, dynamic> j) => ActivityEvent(
        id: (j['id'] as num?)?.toInt() ?? 0,
        at: DateTime.fromMillisecondsSinceEpoch((j['at'] as num?)?.toInt() ?? 0),
        feed: j['feed'] as String? ?? 'chat',
        kind: j['kind'] as String? ?? '',
        turnId: j['turnId'] as String?,
        channel: j['channel'] as String?,
        agent: j['agent'] as String?,
        data: j['data'] is Map ? Map<String, dynamic>.from(j['data'] as Map) : <String, dynamic>{},
      );

  String text(String key) => data[key] is String ? data[key] as String : '';
}

/// A message in the conversation as stored (shared with Telegram).
class ChatHistoryItem {
  ChatHistoryItem({required this.fromUser, required this.text, this.pictures = 0, this.tools = const []});
  final bool fromUser;
  final String text;
  final int pictures;
  final List<String> tools;

  factory ChatHistoryItem.fromJson(Map<String, dynamic> j) => ChatHistoryItem(
        fromUser: j['role'] == 'user',
        text: j['text'] as String? ?? '',
        pictures: (j['pictures'] as num?)?.toInt() ?? 0,
        tools: j['tools'] is List ? (j['tools'] as List).whereType<Map>().map((t) => '${t['name']}').toList() : const [],
      );
}

class ChatState {
  ChatState({required this.busy, this.task, this.autonomous, this.appTurn = false});
  final bool busy;
  final String? task;
  final String? autonomous;
  final bool appTurn;

  factory ChatState.fromJson(Map<String, dynamic> j) =>
      ChatState(busy: j['busy'] == true, task: j['task'] as String?, autonomous: j['autonomous'] as String?, appTurn: j['appTurn'] == true);
}

/// A picture to send: JPEG or PNG bytes, already shrunk on the phone.
class ChatPicture {
  ChatPicture(this.bytes, {this.mediaType = 'image/jpeg'});
  final List<int> bytes;
  final String mediaType;
}

/// Dave is in the middle of something else. [task] says what.
class DaveBusyException implements Exception {
  DaveBusyException(this.task);
  final String? task;
  @override
  String toString() => 'Dave is busy${task == null ? '' : ' with: $task'}';
}

class ChatApi {
  ChatApi({required this.base, required this.token, http.Client? client, this.streamClient = http.Client.new})
      : _http = client ?? http.Client(),
        _ownsClient = client == null;

  /// Shares the app's client (and its test fakes); never closes it.
  factory ChatApi.of(DaveApi api) => ChatApi(base: api.base, token: api.token, client: api.httpClient, streamClient: api.streamClient ?? http.Client.new);

  final Uri base;
  final String token;
  final http.Client _http;
  final bool _ownsClient;
  final http.Client Function() streamClient;

  /// A live feed from [after] on.
  ActivityStream stream({required int after, List<String>? feeds}) => ActivityStream(base: base, token: token, after: after, feeds: feeds, newClient: streamClient);

  static const _timeout = Duration(seconds: 20);
  static const prefix = '/api/app/chat';

  Map<String, String> get _headers => {'authorization': 'Bearer $token', 'accept': 'application/json'};

  Uri _url(String path, [Map<String, String>? query]) => base.replace(path: '$prefix/$path', queryParameters: query);

  Future<Map<String, dynamic>> _call(Future<http.Response> Function() call, {Duration timeout = _timeout}) async {
    final http.Response res;
    try {
      res = await call().timeout(timeout);
    } on TimeoutException {
      throw const ApiException('The server took too long to answer.');
    } on http.ClientException {
      throw const ApiException('No connection to the server.');
    } on Exception {
      throw const ApiException('No connection to the server.');
    }
    if (res.statusCode == 401) throw const UnpairedException();
    Map<String, dynamic> body;
    try {
      final v = jsonDecode(utf8.decode(res.bodyBytes));
      body = v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
    } catch (_) {
      body = <String, dynamic>{};
    }
    if (res.statusCode == 409 && body['error'] == 'busy') throw DaveBusyException(body['task'] as String?);
    if (res.statusCode == 404) {
      throw const ApiException('This server does not have chat yet. Update Dave on Railway, then try again.', statusCode: 404);
    }
    if (res.statusCode >= 400) {
      throw ApiException(body['error'] is String ? body['error'] as String : 'The server returned an error (${res.statusCode}).', statusCode: res.statusCode);
    }
    return body;
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, Object?> body, {Duration timeout = _timeout}) =>
      _call(() => _http.post(_url(path), headers: {..._headers, 'content-type': 'application/json'}, body: jsonEncode(body)), timeout: timeout);

  Future<({List<ChatHistoryItem> items, int latestEventId})> history({int limit = 60}) async {
    final body = await _call(() => _http.get(_url('history', {'limit': '$limit'}), headers: _headers));
    final list = body['items'];
    return (
      items: list is List ? list.whereType<Map>().map((m) => ChatHistoryItem.fromJson(Map<String, dynamic>.from(m))).toList() : <ChatHistoryItem>[],
      latestEventId: (body['latestEventId'] as num?)?.toInt() ?? 0,
    );
  }

  Future<ChatState> state() async => ChatState.fromJson(await _call(() => _http.get(_url('state'), headers: _headers)));

  Future<({List<ActivityEvent> events, int latestEventId})> activity({int after = 0, List<String>? feeds}) async {
    final body = await _call(() => _http.get(_url('activity', {'after': '$after', if (feeds != null) 'feeds': feeds.join(',')}), headers: _headers));
    final list = body['events'];
    return (
      events: list is List ? list.whereType<Map>().map((m) => ActivityEvent.fromJson(Map<String, dynamic>.from(m))).toList() : <ActivityEvent>[],
      latestEventId: (body['latestEventId'] as num?)?.toInt() ?? after,
    );
  }

  /// Starts a turn and returns its id. Throws [DaveBusyException] when Dave is busy, unless
  /// [whenFree] -- then it is queued and runs as soon as he's done.
  Future<String> send(String text, {List<ChatPicture> pictures = const [], bool whenFree = false}) async {
    final body = await _post(
      'send',
      {
        'text': text,
        if (pictures.isNotEmpty) 'images': [for (final p in pictures) {'data': base64Encode(p.bytes), 'mediaType': p.mediaType}],
        if (whenFree) 'whenFree': true,
      },
      timeout: const Duration(seconds: 60),
    );
    return body['turnId'] as String? ?? '';
  }

  Future<bool> stop() async => (await _post('stop', {}))['stopped'] == true;

  /// A card's button tapped in the app -- the same thing tapping it in Telegram does.
  Future<String> action(String callback, {int? messageId}) async =>
      (await _post('action', {'callback': callback, 'messageId': ?messageId}, timeout: const Duration(seconds: 60)))['result'] as String? ?? 'Done.';

  void close() {
    if (_ownsClient) _http.close();
  }
}

/// A live connection to the activity feed that reconnects on its own and never loses an event
/// (it resumes from the last id it saw). Listen to [events]; [connected] says whether it is live.
class ActivityStream {
  ActivityStream({required this.base, required this.token, required int after, this.feeds, http.Client Function()? newClient})
      : _lastId = after,
        _newClient = newClient ?? http.Client.new;

  final http.Client Function() _newClient;

  final Uri base;
  final String token;
  final List<String>? feeds;
  int _lastId;
  bool _closed = false;
  http.Client? _client;
  Timer? _watchdog;
  DateTime _lastByte = DateTime.now();

  final _events = StreamController<ActivityEvent>.broadcast();
  final _connected = StreamController<bool>.broadcast();
  final _ready = StreamController<ChatState>.broadcast();

  Stream<ActivityEvent> get events => _events.stream;
  Stream<bool> get connected => _connected.stream;

  /// Sent on every (re)connect with whether Dave is busy right then.
  Stream<ChatState> get ready => _ready.stream;
  int get lastId => _lastId;

  /// Heartbeats come every 25s; longer silence means a dead socket nobody told us about.
  static const _silence = Duration(seconds: 70);

  void start() {
    _watchdog = Timer.periodic(const Duration(seconds: 20), (_) {
      if (DateTime.now().difference(_lastByte) > _silence) _client?.close();
    });
    unawaited(_run());
  }

  Future<void> _run() async {
    var backoff = const Duration(seconds: 2);
    while (!_closed) {
      final client = _newClient();
      _client = client;
      try {
        final req = http.Request('GET', base.replace(path: '${ChatApi.prefix}/stream', queryParameters: {'after': '$_lastId', if (feeds != null) 'feeds': feeds!.join(',')}))
          ..headers.addAll({'authorization': 'Bearer $token', 'accept': 'text/event-stream', 'cache-control': 'no-cache'});
        final res = await client.send(req).timeout(const Duration(seconds: 20));
        if (res.statusCode == 401) {
          _events.addError(const UnpairedException());
          return;
        }
        if (res.statusCode != 200) throw ApiException('Live feed refused (${res.statusCode}).', statusCode: res.statusCode);
        _lastByte = DateTime.now();
        _connected.add(true);
        backoff = const Duration(seconds: 2);
        final parser = SseParser();
        await for (final line in res.stream.transform(utf8.decoder).transform(const LineSplitter())) {
          _lastByte = DateTime.now();
          final frame = parser.addLine(line);
          if (frame == null) continue;
          try {
            final v = jsonDecode(frame.data);
            if (v is! Map) continue;
            final map = Map<String, dynamic>.from(v);
            if (frame.event == 'ready') {
              _ready.add(ChatState.fromJson(map));
            } else if (frame.event == 'activity') {
              final e = ActivityEvent.fromJson(map);
              if (e.id <= _lastId) continue;
              _lastId = e.id;
              _events.add(e);
            }
          } catch (_) {
            // a malformed frame is skipped, never fatal
          }
          if (_closed) break;
        }
      } catch (_) {
        // dropped -- reconnect below
      } finally {
        client.close();
      }
      if (_closed) return;
      _connected.add(false);
      await Future<void>.delayed(backoff);
      backoff = Duration(seconds: math.min(backoff.inSeconds * 2, 30));
    }
  }

  void close() {
    _closed = true;
    _watchdog?.cancel();
    _client?.close();
    _events.close();
    _connected.close();
    _ready.close();
  }
}
