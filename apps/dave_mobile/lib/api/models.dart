/// Typed views of the /api/app/* JSON the admin server returns.
///
/// Parsing is deliberately forgiving: a missing or null field becomes null / empty rather than a
/// crash. The server is honest about what it does not know (no EA connected yet -> balance null),
/// and the screens are built to show that honestly too, so a null here is information, not an
/// error.
library;

double? _num(Object? v) => v is num ? v.toDouble() : null;
int? _int(Object? v) => v is num ? v.toInt() : null;
String _str(Object? v, [String fallback = '']) => v is String ? v : fallback;
List<Map<String, dynamic>> _list(Object? v) =>
    v is List ? v.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList() : const [];
Map<String, dynamic> _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : const {};
DateTime? _ms(Object? v) => v is num ? DateTime.fromMillisecondsSinceEpoch(v.toInt()) : null;

class Position {
  Position({required this.ticket, required this.symbol, required this.isBuy, required this.lots, required this.openPrice, this.sl, this.tp, this.currentPrice, this.pnl});

  final String ticket;
  final String symbol;
  final bool isBuy;
  final double lots;
  final double openPrice;
  final double? sl;
  final double? tp;
  final double? currentPrice;
  final double? pnl;

  factory Position.fromJson(Map<String, dynamic> j) => Position(
        ticket: _str(j['ticket']),
        symbol: _str(j['symbol'], '?'),
        isBuy: j['type'] == 'buy',
        lots: _num(j['lots']) ?? 0,
        openPrice: _num(j['openPrice']) ?? 0,
        sl: _num(j['sl']),
        tp: _num(j['tp']),
        currentPrice: _num(j['currentPrice']),
        pnl: _num(j['pnl']),
      );
}

class PendingOrder {
  PendingOrder({required this.ticket, required this.symbol, required this.type, required this.lots, required this.price});

  final String ticket;
  final String symbol;
  final String type;
  final double lots;
  final double price;

  /// "buy_limit" -> "Buy limit".
  String get label {
    final t = type.replaceAll('_', ' ');
    return t.isEmpty ? 'Order' : '${t[0].toUpperCase()}${t.substring(1)}';
  }

  factory PendingOrder.fromJson(Map<String, dynamic> j) => PendingOrder(
        ticket: _str(j['ticket']),
        symbol: _str(j['symbol'], '?'),
        type: _str(j['type']),
        lots: _num(j['lots']) ?? 0,
        price: _num(j['price']) ?? 0,
      );
}

class HeatDay {
  HeatDay(this.day, this.pnl, this.trades);
  final String day; // YYYY-MM-DD
  final double pnl;
  final int trades;
}

class Dashboard {
  Dashboard({
    required this.balance,
    required this.equity,
    required this.freeMargin,
    required this.leverage,
    required this.accountUpdatedAt,
    required this.eaConnected,
    required this.eaLastSeenAt,
    required this.positions,
    required this.pendingOrders,
    required this.maxOpenTrades,
    required this.closedTrades,
    required this.wins,
    required this.losses,
    required this.winRatePercent,
    required this.realisedPnl,
    required this.heatmap,
    required this.emptyReason,
  });

  final double? balance;
  final double? equity;
  final double? freeMargin;
  final int? leverage;
  final DateTime? accountUpdatedAt;
  final bool eaConnected;
  final DateTime? eaLastSeenAt;
  final List<Position> positions;
  final List<PendingOrder> pendingOrders;
  final int? maxOpenTrades;
  final int closedTrades;
  final int wins;
  final int losses;
  final int? winRatePercent;
  final double realisedPnl;
  final List<HeatDay> heatmap;
  final String? emptyReason;

  /// Floating P&L across everything open right now.
  double get openPnl => positions.fold(0, (sum, p) => sum + (p.pnl ?? 0));

  factory Dashboard.fromJson(Map<String, dynamic> j) {
    final account = _map(j['account']);
    final ea = _map(j['ea']);
    final open = _map(j['open']);
    final results = _map(j['results']);
    final heat = _map(j['heatmap']);
    return Dashboard(
      balance: _num(account['balance']),
      equity: _num(account['equity']),
      freeMargin: _num(account['freeMargin']),
      leverage: _int(account['leverage']),
      accountUpdatedAt: _ms(account['updatedAt']),
      eaConnected: ea['connected'] == true,
      eaLastSeenAt: _ms(ea['lastSeenAt']),
      positions: _list(open['positions']).map(Position.fromJson).toList(),
      pendingOrders: _list(open['pendingOrders']).map(PendingOrder.fromJson).toList(),
      maxOpenTrades: _int(open['maxOpenTrades']),
      closedTrades: _int(results['closedTrades']) ?? 0,
      wins: _int(results['wins']) ?? 0,
      losses: _int(results['losses']) ?? 0,
      winRatePercent: _int(results['winRatePercent']),
      realisedPnl: _num(results['realisedPnl']) ?? 0,
      heatmap: _list(heat['buckets']).map((b) => HeatDay(_str(b['day']), _num(b['pnl']) ?? 0, _int(b['trades']) ?? 0)).toList(),
      emptyReason: j['emptyReason'] is String ? j['emptyReason'] as String : null,
    );
  }
}

class KnowledgeItem {
  KnowledgeItem({required this.id, required this.title, required this.useWhen, required this.createdAt, required this.chars});
  final String id;
  final String title;
  final String useWhen;
  final DateTime? createdAt;
  final int chars;
}

class Brain {
  Brain({required this.userFacts, required this.notes, required this.usedChars, required this.budgetChars, required this.usagePercent, required this.knowledge});

  /// Memory about the person: small, hard-capped, loaded into every turn.
  final List<String> userFacts;
  final List<String> notes;
  final int usedChars;
  final int budgetChars;
  final int usagePercent;

  /// Knowledge about markets and Dave's own trading: unbounded, survives a reset.
  final List<KnowledgeItem> knowledge;

  factory Brain.fromJson(Map<String, dynamic> j) {
    final memory = _map(j['memory']);
    final knowledge = _map(j['knowledge']);
    List<String> strings(Object? v) => v is List ? v.whereType<String>().toList() : const [];
    return Brain(
      userFacts: strings(memory['user']),
      notes: strings(memory['notes']),
      usedChars: _int(memory['usedChars']) ?? 0,
      budgetChars: _int(memory['budgetChars']) ?? 1,
      usagePercent: _int(memory['usagePercent']) ?? 0,
      knowledge: _list(knowledge['entries'])
          .map((k) => KnowledgeItem(id: _str(k['id']), title: _str(k['title'], 'Untitled'), useWhen: _str(k['useWhen']), createdAt: _ms(k['createdAt']), chars: _int(k['chars']) ?? 0))
          .toList(),
    );
  }
}

class Skill {
  Skill({required this.id, required this.name, required this.description, required this.source, required this.permanent, required this.active, required this.contentChars, this.content});

  final String id;
  final String name;
  final String description;
  final String source;
  final bool permanent;
  final bool active;
  final int contentChars;

  /// Only present when fetched individually -- the list deliberately omits bodies.
  final String? content;

  factory Skill.fromJson(Map<String, dynamic> j) => Skill(
        id: _str(j['id']),
        name: _str(j['name'], 'Untitled'),
        description: _str(j['description']),
        source: _str(j['source']),
        permanent: j['permanent'] == true,
        active: j['active'] == true,
        contentChars: _int(j['contentChars']) ?? (j['content'] is String ? (j['content'] as String).length : 0),
        content: j['content'] is String ? j['content'] as String : null,
      );
}

class BotState {
  BotState({required this.running, required this.executionEnabled, required this.intervalMinutes, required this.minInterval, required this.maxInterval});

  /// Whether Dave scans for setups at all.
  final bool running;

  /// Whether a normal setup may be taken automatically. Off = watch-only: Dave still analyses and
  /// manages what is open, but asks before a new trade.
  final bool executionEnabled;
  final int intervalMinutes;
  final int minInterval;
  final int maxInterval;

  factory BotState.fromJson(Map<String, dynamic> j) {
    final bounds = _map(j['intervalBounds']);
    return BotState(
      running: j['running'] == true,
      executionEnabled: j['executionEnabled'] != false,
      intervalMinutes: _int(j['intervalMinutes']) ?? 5,
      minInterval: _int(bounds['min']) ?? 1,
      maxInterval: _int(bounds['max']) ?? 60,
    );
  }
}

/// One trade open or close from /api/app/events.
class TradeEvent {
  TradeEvent({required this.id, required this.type, required this.ticket, required this.symbol, this.isBuy, this.lots, this.openPrice, this.sl, this.tp, this.pnl, this.reason});

  final int id;
  final String type; // "opened" | "closed"
  final String ticket;
  final String symbol;
  final bool? isBuy;
  final double? lots;
  final double? openPrice;
  final double? sl;
  final double? tp;
  final double? pnl;
  final String? reason; // tp | sl | dave | manual

  bool get isOpen => type == 'opened';

  factory TradeEvent.fromJson(Map<String, dynamic> j) => TradeEvent(
        id: _int(j['id']) ?? 0,
        type: _str(j['type']),
        ticket: _str(j['ticket']),
        symbol: _str(j['symbol'], '?'),
        isBuy: j['side'] == null ? null : j['side'] == 'buy',
        lots: _num(j['lots']),
        openPrice: _num(j['openPrice']),
        sl: _num(j['sl']),
        tp: _num(j['tp']),
        pnl: _num(j['pnl']),
        reason: j['reason'] is String ? j['reason'] as String : null,
      );
}
