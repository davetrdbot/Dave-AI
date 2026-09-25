import '../api/chat.dart';

/// What the Chat screen shows, built from the stored conversation plus the live activity feed.
/// Pure Dart -- no widgets -- so every event's effect is unit-tested.

sealed class ChatEntry {}

/// A message from the stored conversation (before this screen started listening).
class HistoryEntry extends ChatEntry {
  HistoryEntry(this.item);
  final ChatHistoryItem item;
}

/// One step inside a turn, in the order it happened.
class TurnStep {
  TurnStep.tool({required this.id, required this.name, required this.label, this.args, this.agent}) : kind = 'tool';
  TurnStep.text(this.text, {this.agent}) : kind = 'text', id = '', name = '', label = '';
  TurnStep.thinking(this.text, {this.agent}) : kind = 'thinking', id = '', name = '', label = '';
  TurnStep.card(this.card) : kind = 'card', id = '', name = '', label = '', agent = null;

  final String kind;
  final String id;
  final String name;
  final String label;
  final String? agent;
  Object? args;
  Object? result;
  bool running = true;
  bool isError = false;
  int? ms;
  String text = '';
  CardEntry? card;
}

/// One exchange: the trader's message, every step Dave took, and his answer.
class TurnEntry extends ChatEntry {
  TurnEntry(this.turnId, {this.channel = 'app', this.userText = '', this.pictures = 0, DateTime? startedAt}) : startedAt = startedAt ?? DateTime.now();

  final String turnId;
  String channel;
  String userText;
  int pictures;
  final DateTime startedAt;
  final steps = <TurnStep>[];
  bool started = false;
  bool done = false;
  String? finalText;
  String? stopped;
  String? error;
  String? notice;
  String? question;
  List<String> options = const [];
  int? tokens;

  /// Sent from this phone and not yet confirmed by the server.
  bool pending = false;

  bool get fromTelegram => channel == 'telegram';
  bool get running => !done;
  Iterable<TurnStep> get tools => steps.where((s) => s.kind == 'tool');
  Iterable<TurnStep> get thoughts => steps.where((s) => s.kind == 'thinking');
}

/// A card or note that stands on its own: a Nous signal, a worker's report, an alert.
class CardEntry extends ChatEntry {
  CardEntry(this.event);
  final ActivityEvent event;

  /// The button the trader tapped, once they have.
  String? used;

  /// What the server said after the tap.
  String? result;

  String get kind => event.kind;
  List<dynamic> get blocks => event.data['blocks'] is List ? event.data['blocks'] as List : const [];
  String get text => event.text('text').isNotEmpty ? event.text('text') : event.text('markdown');
  String get html => event.text('html');
  Object? get buttons => event.data['buttons'];
}

/// Background events worth a place in the conversation. Everything else from the loop and the
/// workers goes to the Live tab.
const chatBackgroundKinds = {'nous_card', 'nous_note', 'worker_report', 'worker_done', 'alert', 'scalp', 'trade_closed', 'trade_modified'};

class ChatTimeline {
  final entries = <ChatEntry>[];
  final _turns = <String, TurnEntry>{};
  var _localId = 0;

  void loadHistory(List<ChatHistoryItem> items) {
    entries
      ..clear()
      ..addAll(items.map(HistoryEntry.new));
    _turns.clear();
  }

  TurnEntry? turn(String id) => _turns[id];

  /// The turn still running, if any (the one Stop would stop).
  TurnEntry? get runningTurn {
    for (final e in entries.reversed) {
      if (e is TurnEntry && e.running && !e.pending) return e;
    }
    return null;
  }

  /// Shows the trader's message straight away, before the server confirms it.
  TurnEntry addPending(String text, int pictures) {
    final t = TurnEntry('local-${_localId++}', userText: text, pictures: pictures)..pending = true;
    _turns[t.turnId] = t;
    entries.add(t);
    return t;
  }

  /// The server accepted it as [turnId]: the pending bubble becomes that turn (unless the live
  /// feed already delivered the turn, in which case the placeholder just goes).
  void confirmPending(TurnEntry pending, String turnId) {
    _turns.remove(pending.turnId);
    final existing = _turns[turnId];
    if (existing != null) {
      entries.remove(pending);
      return;
    }
    final t = TurnEntry(turnId, userText: pending.userText, pictures: pending.pictures, startedAt: pending.startedAt);
    final i = entries.indexOf(pending);
    if (i >= 0) {
      entries[i] = t;
    } else {
      entries.add(t);
    }
    _turns[turnId] = t;
  }

  void failPending(TurnEntry pending, String error) {
    pending
      ..pending = false
      ..done = true
      ..error = error;
  }

  TurnEntry _turnFor(ActivityEvent e) {
    final id = e.turnId!;
    return _turns.putIfAbsent(id, () {
      final t = TurnEntry(id, channel: e.channel ?? 'app', startedAt: e.at);
      entries.add(t);
      return t;
    });
  }

  /// Applies one live event. Returns whether anything visible changed.
  bool apply(ActivityEvent e) {
    if (e.feed == 'background') {
      if (!chatBackgroundKinds.contains(e.kind)) return false;
      entries.add(CardEntry(e));
      return true;
    }
    if (e.feed != 'chat') return false;
    if (e.turnId == null) {
      // A message outside any turn: a button's answer, a tool run on its own.
      if (e.kind == 'message') {
        entries.add(CardEntry(e));
        return true;
      }
      return false;
    }
    final t = _turnFor(e);
    switch (e.kind) {
      case 'user_message':
        t.userText = e.text('text');
        t.pictures = (e.data['images'] as num?)?.toInt() ?? 0;
        t.channel = e.channel ?? t.channel;
      case 'turn_start':
        t.started = true;
      case 'tool_start':
        t.steps.add(TurnStep.tool(id: e.text('id'), name: e.text('name'), label: e.text('label'), args: e.data['args'], agent: e.agent));
      case 'tool_end':
        final step = t.steps.lastWhere((s) => s.kind == 'tool' && s.id == e.text('id') && s.running, orElse: () {
          final s = TurnStep.tool(id: e.text('id'), name: e.text('name'), label: e.text('label'), agent: e.agent);
          t.steps.add(s);
          return s;
        });
        step
          ..running = false
          ..result = e.data['result']
          ..isError = e.data['isError'] == true
          ..ms = (e.data['ms'] as num?)?.toInt();
      case 'text':
        if (e.text('text').trim().isNotEmpty) t.steps.add(TurnStep.text(e.text('text'), agent: e.agent));
      case 'thinking':
        if (e.text('text').trim().isNotEmpty) t.steps.add(TurnStep.thinking(e.text('text'), agent: e.agent));
      case 'message':
        t.steps.add(TurnStep.card(CardEntry(e)));
      case 'message_edit':
        final id = (e.data['messageId'] as num?)?.toInt();
        for (final s in t.steps) {
          if (s.kind == 'card' && (s.card!.event.data['id'] as num?)?.toInt() == id) {
            s.card!.event.data
              ..['text'] = e.text('text')
              ..remove('blocks')
              ..remove('html');
          }
        }
      case 'message_delete':
        final id = (e.data['messageId'] as num?)?.toInt();
        t.steps.removeWhere((s) => s.kind == 'card' && (s.card!.event.data['id'] as num?)?.toInt() == id);
      case 'notice':
        t.notice = e.text('text');
      case 'final':
        _finish(t);
        t.finalText = e.text('text');
        t.stopped = e.data['stopped'] as String?;
        t.tokens = _tokens(e);
      case 'ask_user':
        _finish(t);
        t.question = e.text('question');
        t.options = e.data['options'] is List ? (e.data['options'] as List).map((o) => '$o').toList() : const [];
        t.tokens = _tokens(e);
      case 'error':
        _finish(t);
        t.error = e.text('message');
      default:
        return false;
    }
    return true;
  }

  static int? _tokens(ActivityEvent e) => e.data['usage'] is Map ? ((e.data['usage'] as Map)['totalTokens'] as num?)?.toInt() : null;

  void _finish(TurnEntry t) {
    t.done = true;
    for (final s in t.steps) {
      s.running = false;
    }
  }
}
