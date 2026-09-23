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

/// One realised trade -- the raw material for the range views and the P&L chart.
class ClosedTrade {
  ClosedTrade({required this.at, required this.pnl, required this.symbol, this.isBuy});
  final DateTime at;
  final double pnl;
  final String symbol;
  final bool? isBuy;
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
    required this.trades,
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

  /// Closed trades over the last year, oldest first. Ranges and charts are built from these in
  /// the phone's own time zone.
  final List<ClosedTrade> trades;
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
      trades: _list(j['trades'])
          .where((t) => t['at'] is num && t['pnl'] is num)
          .map((t) => ClosedTrade(at: _ms(t['at'])!, pnl: _num(t['pnl'])!, symbol: _str(t['symbol'], '?'), isBuy: t['side'] == null ? null : t['side'] == 'buy'))
          .toList(),
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
  TradeEvent({required this.id, required this.type, required this.ticket, required this.symbol, this.isBuy, this.lots, this.openPrice, this.sl, this.tp, this.pnl, this.reason, this.text});

  final int id;
  final String type; // "opened" | "closed" | "reminder"
  final String ticket;
  final String symbol;
  final bool? isBuy;
  final double? lots;
  final double? openPrice;
  final double? sl;
  final double? tp;
  final double? pnl;
  final String? reason; // tp | sl | dave | manual -- or, on a reminder, why Dave set it
  /// A reminder's own words (what Dave wanted to come back to). Null on a trade.
  final String? text;

  bool get isOpen => type == 'opened';
  bool get isReminder => type == 'reminder';

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
        text: j['text'] is String ? j['text'] as String : null,
      );
}

/// One knowledge entry in full.
class KnowledgeDetail {
  KnowledgeDetail({required this.id, required this.title, required this.useWhen, required this.content, required this.createdAt});
  final String id;
  final String title;
  final String useWhen;
  final String content;
  final DateTime? createdAt;

  factory KnowledgeDetail.fromJson(Map<String, dynamic> j) =>
      KnowledgeDetail(id: _str(j['id']), title: _str(j['title'], 'Untitled'), useWhen: _str(j['useWhen']), content: _str(j['content']), createdAt: _ms(j['createdAt']));
}

/// A bounded number setting: its value and the range the server accepts.
class Bounded {
  Bounded(this.value, this.min, this.max);
  final double value;
  final double min;
  final double max;

  factory Bounded.fromJson(Object? v, double fallback, double min, double max) {
    final m = _map(v);
    return Bounded(_num(m['value']) ?? fallback, _num(m['min']) ?? min, _num(m['max']) ?? max);
  }
}

/// Stop loss / take profit / lot size: off, a fixed value, or Dave decides.
class RiskMode {
  RiskMode(this.mode, this.value, this.unit);
  final String mode; // off | on | auto
  final double? value;
  final String unit;

  factory RiskMode.fromJson(Object? v) {
    final m = _map(v);
    return RiskMode(_str(m['mode'], 'off'), _num(m['value']), _str(m['unit']));
  }

  String get summary => switch (mode) {
        'on' => value == null ? 'Fixed' : '${_trim(value!)} $unit',
        'auto' => 'Dave decides',
        _ => 'Off',
      };
}

String _trim(double v) => v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toString();

class PairGroupOption {
  PairGroupOption(this.id, this.name, this.symbols);
  final String id;
  final String name;
  final int symbols;
}

class AlertToggle {
  AlertToggle(this.id, this.label, this.on);
  final String id;
  final String label;
  final bool on;
}

/// Every bot setting the app can change, as /api/app/settings returns it.
class AppSettings {
  AppSettings({
    required this.riskReward,
    required this.confidence,
    required this.autoApproveBelowThreshold,
    required this.stopLoss,
    required this.takeProfit,
    required this.lotSize,
    required this.maxOpenTrades,
    required this.maxDailyLossPct,
    required this.session,
    required this.sessions,
    required this.pairGroup,
    required this.pairGroups,
    required this.autoApproval,
    required this.selfPause,
    required this.twoStepTrading,
    required this.sequentialThinking,
    required this.memoryWriteApproval,
    required this.deepLossPercent,
    required this.alerts,
    required this.primaryTimeout,
    required this.fallbackTimeout,
  });

  final Bounded riskReward;
  final Bounded confidence;
  final bool autoApproveBelowThreshold;
  final RiskMode stopLoss;
  final RiskMode takeProfit;
  final RiskMode lotSize;
  final int? maxOpenTrades;
  final double? maxDailyLossPct;
  final String session;
  final List<String> sessions;
  final String? pairGroup;
  final List<PairGroupOption> pairGroups;
  final bool autoApproval;
  final bool selfPause;
  final bool twoStepTrading;
  final bool sequentialThinking;
  final bool memoryWriteApproval;
  final Bounded deepLossPercent;
  final List<AlertToggle> alerts;
  final Bounded primaryTimeout;
  final Bounded fallbackTimeout;

  factory AppSettings.fromJson(Map<String, dynamic> j) {
    final t = _map(j['trading']);
    final b = _map(j['behaviour']);
    final a = _map(j['alerts']);
    final ai = _map(j['ai']);
    final session = _map(t['session']);
    final group = _map(t['pairGroup']);
    return AppSettings(
      riskReward: Bounded.fromJson(t['riskReward'], 1, 0.1, 100),
      confidence: Bounded.fromJson(t['confidenceThreshold'], 70, 0, 100),
      autoApproveBelowThreshold: t['autoApproveBelowThreshold'] == true,
      stopLoss: RiskMode.fromJson(t['stopLoss']),
      takeProfit: RiskMode.fromJson(t['takeProfit']),
      lotSize: RiskMode.fromJson(t['lotSize']),
      maxOpenTrades: _int(t['maxOpenTrades']),
      maxDailyLossPct: _num(t['maxDailyLossPct']),
      session: _str(session['value'], 'all'),
      sessions: session['options'] is List ? (session['options'] as List).whereType<String>().toList() : const ['all'],
      pairGroup: group['value'] is String ? group['value'] as String : null,
      pairGroups: _list(group['options']).map((g) => PairGroupOption(_str(g['id']), _str(g['name'], '?'), _int(g['symbols']) ?? 0)).toList(),
      autoApproval: b['autoApproval'] == true,
      selfPause: b['selfPause'] == true,
      twoStepTrading: b['twoStepTrading'] == true,
      sequentialThinking: b['sequentialThinking'] == true,
      memoryWriteApproval: b['memoryWriteApproval'] == true,
      deepLossPercent: Bounded.fromJson(a['deepLossPercent'], 50, 5, 95),
      alerts: _list(a['toggles']).map((x) => AlertToggle(_str(x['id']), _str(x['label']), x['on'] != false)).toList(),
      primaryTimeout: Bounded.fromJson(ai['primaryTimeoutSeconds'], 20, 3, 120),
      fallbackTimeout: Bounded.fromJson(ai['fallbackTimeoutSeconds'], 5, 3, 120),
    );
  }
}

class BasetenKey {
  BasetenKey({required this.id, required this.label, required this.maskedKey, required this.model, required this.healthy, required this.isPrimary, this.lastError});
  final String id;
  final String label;
  final String maskedKey;
  final String model;
  final bool healthy;
  final bool isPrimary;
  final String? lastError;
}

/// The Baseten provider: whether Dave uses it, and its keys.
class BasetenState {
  BasetenState({required this.isPrimary, required this.defaultModel, required this.keys});
  final bool isPrimary;
  final String defaultModel;
  final List<BasetenKey> keys;

  /// The model every key uses (they are kept the same), or the catalog default with no keys.
  String get model => keys.isEmpty ? defaultModel : keys.first.model;

  factory BasetenState.fromJson(Map<String, dynamic> j) => BasetenState(
        isPrimary: j['isPrimary'] == true,
        defaultModel: _str(j['defaultModel']),
        keys: _list(j['keys'])
            .map((k) => BasetenKey(
                  id: _str(k['id']),
                  label: _str(k['label'], 'Key'),
                  maskedKey: _str(k['maskedKey']),
                  model: _str(k['model']),
                  healthy: k['healthy'] == true,
                  isPrimary: k['isPrimary'] == true,
                  lastError: k['lastError'] is String ? k['lastError'] as String : null,
                ))
            .toList(),
      );
}
