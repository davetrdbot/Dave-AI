import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'models.dart';

/// Thrown when the server no longer recognises this phone -- it was disconnected from the web
/// panel, or its token is gone. The app's only correct response is to go back to the connect
/// screen and say so; retrying cannot fix it.
class UnpairedException implements Exception {
  const UnpairedException([this.message = 'This phone was disconnected. Pair it again from the web panel.']);
  final String message;
  @override
  String toString() => message;
}

/// Anything else that went wrong talking to the server, phrased for a person.
class ApiException implements Exception {
  const ApiException(this.message, {this.statusCode});
  final String message;
  final int? statusCode;
  @override
  String toString() => message;
}

/// Turns whatever someone types into the address box into a usable base URL.
///
/// People will type "dave-bot-production.up.railway.app", "https://...app/", or paste a URL with
/// a path on the end. All of those mean the same server. Returns null for anything that is not a
/// server address.
///
/// Refuses plain http:// to anything that is not on the local network: every later request
/// carries the device token, and sending it unencrypted across the internet would hand it to
/// anyone on the path. http is allowed only for a LAN or the emulator, which is how you test
/// against a server on your own computer.
Uri? normaliseEndpoint(String input) {
  var text = input.trim();
  if (text.isEmpty) return null;
  if (!text.contains('://')) text = 'https://$text';
  final Uri uri;
  try {
    uri = Uri.parse(text);
  } catch (_) {
    return null;
  }
  if (uri.host.isEmpty || !(uri.scheme == 'https' || uri.scheme == 'http')) return null;
  if (uri.scheme == 'http' && !_isLocal(uri.host)) return null;
  return Uri(scheme: uri.scheme, host: uri.host, port: uri.hasPort ? uri.port : null);
}

bool _isLocal(String host) {
  if (host == 'localhost' || host == '10.0.2.2') return true; // 10.0.2.2 = the emulator's host
  final ip = InternetAddress.tryParse(host);
  if (ip == null) return false;
  if (ip.isLoopback) return true;
  final b = ip.rawAddress;
  return ip.type == InternetAddressType.IPv4 && (b[0] == 10 || (b[0] == 192 && b[1] == 168) || (b[0] == 172 && b[1] >= 16 && b[1] <= 31));
}

class PairResult {
  PairResult(this.token, this.deviceId);
  final String token;
  final String deviceId;
}

/// The phone's side of the /api/app/* API.
class DaveApi {
  DaveApi({required this.base, required this.token, http.Client? client}) : _http = client ?? http.Client();

  final Uri base;
  final String token;
  final http.Client _http;

  static const _timeout = Duration(seconds: 20);

  /// Exchanges a one-time pairing code for this phone's token. The only call that needs no token.
  static Future<PairResult> pair(Uri base, String code, String label, {http.Client? client}) async {
    final c = client ?? http.Client();
    final http.Response res;
    try {
      res = await c
          .post(base.replace(path: '/api/app/pair'), headers: {'content-type': 'application/json'}, body: jsonEncode({'code': code.trim().toUpperCase(), 'label': label}))
          .timeout(_timeout);
    } on TimeoutException {
      throw const ApiException('The server took too long to answer. Check the address and try again.');
    } on SocketException {
      throw const ApiException('Could not reach that server. Check the address and your connection.');
    } on HandshakeException {
      throw const ApiException('Could not make a secure connection to that server.');
    }
    final body = _decode(res);
    if (res.statusCode != 200) {
      throw ApiException(body['error'] is String ? body['error'] as String : 'Pairing failed (${res.statusCode}).', statusCode: res.statusCode);
    }
    final token = body['token'];
    if (token is! String || token.isEmpty) throw const ApiException('The server did not return a token.');
    final device = body['device'];
    return PairResult(token, device is Map && device['id'] is String ? device['id'] as String : '');
  }

  Map<String, String> get _headers => {'authorization': 'Bearer $token', 'accept': 'application/json'};

  Uri _url(String path, [Map<String, String>? query]) => base.replace(path: path, queryParameters: query);

  Future<Map<String, dynamic>> _send(Future<http.Response> Function() call) async {
    final http.Response res;
    try {
      res = await call().timeout(_timeout);
    } on TimeoutException {
      throw const ApiException('The server took too long to answer.');
    } on SocketException {
      throw const ApiException('No connection to the server.');
    } on HandshakeException {
      throw const ApiException('Could not make a secure connection to the server.');
    } on http.ClientException {
      throw const ApiException('The connection to the server was interrupted.');
    }
    if (res.statusCode == 401) throw const UnpairedException();
    final body = _decode(res);
    if (res.statusCode >= 400) {
      throw ApiException(body['error'] is String ? body['error'] as String : 'The server returned an error (${res.statusCode}).', statusCode: res.statusCode);
    }
    return body;
  }

  static Map<String, dynamic> _decode(http.Response res) {
    try {
      final v = jsonDecode(utf8.decode(res.bodyBytes));
      return v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  Future<Dashboard> dashboard() async => Dashboard.fromJson(await _send(() => _http.get(_url('/api/app/dashboard'), headers: _headers)));

  Future<Brain> brain() async => Brain.fromJson(await _send(() => _http.get(_url('/api/app/brain'), headers: _headers)));

  Future<List<Skill>> skills() async {
    final body = await _send(() => _http.get(_url('/api/app/skills'), headers: _headers));
    final list = body['skills'];
    return list is List ? list.whereType<Map>().map((m) => Skill.fromJson(Map<String, dynamic>.from(m))).toList() : <Skill>[];
  }

  Future<Skill> skill(String id) async => Skill.fromJson(await _send(() => _http.get(_url('/api/app/skills', {'id': id}), headers: _headers)));

  Future<void> _skillAction(Map<String, Object?> body) =>
      _send(() => _http.post(_url('/api/app/skills'), headers: {..._headers, 'content-type': 'application/json'}, body: jsonEncode(body)));

  Future<void> activateSkill(String id) => _skillAction({'action': 'activate', 'skillId': id});
  Future<void> deactivateSkill() => _skillAction({'action': 'deactivate'});
  Future<void> installSkillFromGithub(String repoUrl) => _skillAction({'action': 'install-github', 'repoUrl': repoUrl});
  Future<void> deleteSkill(String id) => _send(() => _http.delete(_url('/api/app/skills', {'id': id}), headers: _headers));

  Future<BotState> bot() async => BotState.fromJson(await _send(() => _http.get(_url('/api/app/bot'), headers: _headers)));

  Future<BotState> updateBot({bool? running, bool? executionEnabled, int? intervalMinutes}) async {
    await _send(() => _http.post(_url('/api/app/bot'),
        headers: {..._headers, 'content-type': 'application/json'},
        body: jsonEncode({
          'running': ?running,
          'executionEnabled': ?executionEnabled,
          'intervalMinutes': ?intervalMinutes,
        })));
    return bot();
  }

  /// Every trade event after [afterId] -- the catch-up for when the background service was dead.
  Future<({List<TradeEvent> events, int latestId})> eventsAfter(int afterId) async {
    final body = await _send(() => _http.get(_url('/api/app/events', {'format': 'json', 'after': '$afterId'}), headers: _headers));
    final list = body['events'];
    final events = list is List ? list.whereType<Map>().map((m) => TradeEvent.fromJson(Map<String, dynamic>.from(m))).toList() : <TradeEvent>[];
    final latest = body['latestId'];
    return (events: events, latestId: latest is num ? latest.toInt() : afterId);
  }

  void close() => _http.close();
}
