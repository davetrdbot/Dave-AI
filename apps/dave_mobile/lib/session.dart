import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// What this phone remembers between launches: which server it belongs to, the credential that
/// proves it, and how far through the trade-event log it has read.
///
/// This is the "powered up" state -- the trader enters the address and a code once, and the app
/// never asks again until it is disconnected.
///
/// Two stores, on purpose:
///   - The TOKEN lives in flutter_secure_storage (Android Keystore-backed encryption). It is a
///     bearer credential for the whole trading account's controls; it does not belong in plain
///     preferences.
///   - The endpoint and last event id live in SharedPreferencesAsync. Not the classic
///     SharedPreferences: the notification service runs in a SEPARATE isolate, and the classic API
///     caches values in memory per isolate -- so the service would write "last id 42" and the app
///     would keep reading its own stale cached 17. The async API reads through every time.
class Session {
  Session({required this.endpoint, required this.token});

  final Uri endpoint;
  final String token;

  static const _kEndpoint = 'dave.endpoint';
  static const _kToken = 'dave.token';
  static const _kLastEventId = 'dave.lastEventId';
  static const _kChatEventId = 'dave.chatEventId';
  static const _kNotifications = 'dave.notifications';
  static const _kUnpairedNotice = 'dave.unpairedNotice';

  static const _secure = FlutterSecureStorage();
  static final _prefs = SharedPreferencesAsync();

  static Future<Session?> load() async {
    final endpoint = await _prefs.getString(_kEndpoint);
    final token = await _secure.read(key: _kToken);
    if (endpoint == null || token == null || token.isEmpty) return null;
    final uri = Uri.tryParse(endpoint);
    if (uri == null || uri.host.isEmpty) return null;
    return Session(endpoint: uri, token: token);
  }

  static Future<void> save(Uri endpoint, String token) async {
    await _secure.write(key: _kToken, value: token);
    await _prefs.setString(_kEndpoint, endpoint.toString());
    await _prefs.remove(_kUnpairedNotice);
  }

  /// Forgets the credential. The endpoint is kept, so reconnecting means typing only a new code.
  static Future<void> clear({String? reason}) async {
    await _secure.delete(key: _kToken);
    await _prefs.remove(_kLastEventId);
    await _prefs.remove(_kChatEventId);
    if (reason != null) await _prefs.setString(_kUnpairedNotice, reason);
  }

  static Future<String?> lastEndpoint() => _prefs.getString(_kEndpoint);

  /// A one-time message for the connect screen explaining why the phone ended up back there.
  static Future<String?> takeUnpairedNotice() async {
    final notice = await _prefs.getString(_kUnpairedNotice);
    if (notice != null) await _prefs.remove(_kUnpairedNotice);
    return notice;
  }

  static Future<int?> lastEventId() => _prefs.getInt(_kLastEventId);
  static Future<void> setLastEventId(int id) => _prefs.setInt(_kLastEventId, id);

  /// How far through the chat feed the notification service has read (a separate log from trades).
  static Future<int?> chatEventId() => _prefs.getInt(_kChatEventId);
  static Future<void> setChatEventId(int id) => _prefs.setInt(_kChatEventId, id);

  /// Whether the trader wants trade notifications. Defaults ON once paired.
  static Future<bool> notificationsEnabled() async => await _prefs.getBool(_kNotifications) ?? true;
  static Future<void> setNotificationsEnabled(bool on) => _prefs.setBool(_kNotifications, on);
}
