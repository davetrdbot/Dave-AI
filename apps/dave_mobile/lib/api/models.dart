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

/// One stored API key for a provider. The real key never reaches the phone -- only a masked form.
class ProviderKey {
  ProviderKey({required this.id, required this.label, required this.maskedKey, required this.model, required this.healthy, required this.isPrimary, this.lastError});
  final String id;
  final String label;
  final String maskedKey;
  final String model;
  final bool healthy;
  final bool isPrimary;
  final String? lastError;
}

/// One AI provider in full: its keys, the model, and where it sits in Dave's order.
class ProviderState {
  ProviderState({
    required this.provider,
    required this.name,
    required this.isPrimary,
    required this.defaultModel,
    required this.keys,
    this.backupPosition,
    this.manualModelEntry = false,
    this.requiresExtraConfig = const [],
    this.notes = '',
  });
  final String provider;
  final String name;
  final bool isPrimary;
  final String defaultModel;
  final List<ProviderKey> keys;

  /// 1-based place among the backups, or null when it is not a backup.
  final int? backupPosition;

  /// True when the provider has no model list to pick from -- the model id is typed.
  final bool manualModelEntry;

  /// Extra fields a key needs besides the API key itself (accountId, region, secretAccessKey).
  final List<String> requiresExtraConfig;
  final String notes;

  bool get isBackup => backupPosition != null;

  /// The model every key uses (they are kept the same), or the catalog default with no keys.
  String get model => keys.isEmpty ? defaultModel : keys.first.model;

  factory ProviderState.fromJson(Map<String, dynamic> j) => ProviderState(
        provider: _str(j['provider'], 'baseten'),
        name: _str(j['name'], 'Baseten'),
        isPrimary: j['isPrimary'] == true,
        defaultModel: _str(j['defaultModel']),
        backupPosition: _int(j['backupPosition']),
        manualModelEntry: j['manualModelEntry'] == true,
        requiresExtraConfig: j['requiresExtraConfig'] is List ? (j['requiresExtraConfig'] as List).whereType<String>().toList() : const [],
        notes: _str(j['notes']),
        keys: _list(j['keys'])
            .map((k) => ProviderKey(
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

/// A row on the Providers list.
class ProviderSummary {
  ProviderSummary({required this.provider, required this.name, required this.keyCount, required this.healthyKeys, required this.model, required this.isPrimary, this.backupPosition});
  final String provider;
  final String name;
  final int keyCount;
  final int healthyKeys;
  final String model;
  final bool isPrimary;
  final int? backupPosition;

  bool get isBackup => backupPosition != null;
  bool get inUse => isPrimary || isBackup;

  factory ProviderSummary.fromJson(Map<String, dynamic> j) => ProviderSummary(
        provider: _str(j['provider']),
        name: _str(j['name'], _str(j['provider'])),
        keyCount: _int(j['keyCount']) ?? 0,
        healthyKeys: _int(j['healthyKeys']) ?? 0,
        model: _str(j['model']),
        isPrimary: j['isPrimary'] == true,
        backupPosition: _int(j['backupPosition']),
      );
}

class ProviderList {
  ProviderList({required this.providers});
  final List<ProviderSummary> providers;

  ProviderSummary? get main => providers.where((p) => p.isPrimary).firstOrNull;
  List<ProviderSummary> get backups => providers.where((p) => p.isBackup).toList()..sort((a, b) => a.backupPosition!.compareTo(b.backupPosition!));
  List<ProviderSummary> get withKeys => providers.where((p) => !p.inUse && p.keyCount > 0).toList();
  List<ProviderSummary> get others => providers.where((p) => !p.inUse && p.keyCount == 0).toList();

  factory ProviderList.fromJson(Map<String, dynamic> j) => ProviderList(providers: _list(j['providers']).map(ProviderSummary.fromJson).toList());
}

// --- context window and usage -------------------------------------------------------------------

/// The parts of one request, in the fixed order the panel shows them (and colours them).
const contextParts = ['tools', 'messages', 'systemPrompt', 'skills', 'memory', 'liveContext'];

const contextPartLabels = {
  'tools': 'Tools',
  'messages': 'Messages',
  'systemPrompt': 'System prompt',
  'skills': 'Skills',
  'memory': 'Memory & knowledge',
  'liveContext': 'Live context',
};

/// What one request to the AI was made of.
class ContextSnapshot {
  ContextSnapshot({
    required this.at,
    required this.provider,
    required this.promptTokens,
    required this.estimated,
    required this.parts,
    required this.toolCount,
    required this.messageCount,
    this.model,
    this.contextWindow,
    this.completionTokens,
    this.cachedTokens,
  });
  final DateTime at;
  final String provider;
  final String? model;
  final int promptTokens;
  final int? completionTokens;
  final int? cachedTokens;
  final bool estimated;
  final int? contextWindow;
  final Map<String, int> parts;
  final int toolCount;
  final int messageCount;

  /// Share of the window in use, 0..1, or null when the window is unknown.
  double? get fill => contextWindow == null || contextWindow == 0 ? null : (promptTokens / contextWindow!).clamp(0, 1).toDouble();

  static ContextSnapshot? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final j = Map<String, dynamic>.from(raw);
    final parts = j['parts'] is Map ? Map<String, dynamic>.from(j['parts'] as Map) : const <String, dynamic>{};
    return ContextSnapshot(
      at: DateTime.fromMillisecondsSinceEpoch(_int(j['at']) ?? 0),
      provider: _str(j['provider']),
      model: j['model'] is String ? j['model'] as String : null,
      promptTokens: _int(j['promptTokens']) ?? 0,
      completionTokens: _int(j['completionTokens']),
      cachedTokens: _int(j['cachedTokens']),
      estimated: j['estimated'] == true,
      contextWindow: _int(j['contextWindow']),
      parts: {for (final p in contextParts) p: _int(parts[p]) ?? 0},
      toolCount: _int(j['toolCount']) ?? 0,
      messageCount: _int(j['messageCount']) ?? 0,
    );
  }
}

/// Every AI call in one hour.
class HourUsage {
  HourUsage({required this.start, required this.calls, required this.promptTokens, required this.completionTokens, required this.cachedTokens, required this.estimatedCalls, required this.peakPromptTokens, required this.bySource});
  final DateTime start;
  final int calls;
  final int promptTokens;
  final int completionTokens;
  final int cachedTokens;
  final int estimatedCalls;
  final int peakPromptTokens;
  final Map<String, ({int calls, int tokens})> bySource;

  int get tokens => promptTokens + completionTokens;

  factory HourUsage.fromJson(Map<String, dynamic> j) {
    final src = j['bySource'] is Map ? Map<String, dynamic>.from(j['bySource'] as Map) : const <String, dynamic>{};
    return HourUsage(
      start: DateTime.fromMillisecondsSinceEpoch(_int(j['start']) ?? 0),
      calls: _int(j['calls']) ?? 0,
      promptTokens: _int(j['promptTokens']) ?? 0,
      completionTokens: _int(j['completionTokens']) ?? 0,
      cachedTokens: _int(j['cachedTokens']) ?? 0,
      estimatedCalls: _int(j['estimatedCalls']) ?? 0,
      peakPromptTokens: _int(j['peakPromptTokens']) ?? 0,
      bySource: {
        for (final e in src.entries)
          if (e.value is Map) e.key: (calls: _int((e.value as Map)['calls']) ?? 0, tokens: _int((e.value as Map)['tokens']) ?? 0),
      },
    );
  }
}

/// Totals over a set of hours (one local day, usually).
class UsageTotals {
  UsageTotals(List<HourUsage> hours)
      : calls = hours.fold(0, (s, h) => s + h.calls),
        promptTokens = hours.fold(0, (s, h) => s + h.promptTokens),
        completionTokens = hours.fold(0, (s, h) => s + h.completionTokens),
        cachedTokens = hours.fold(0, (s, h) => s + h.cachedTokens),
        estimatedCalls = hours.fold(0, (s, h) => s + h.estimatedCalls),
        peakPromptTokens = hours.fold(0, (s, h) => s > h.peakPromptTokens ? s : h.peakPromptTokens),
        bySource = _sumSources(hours);
  final int calls;
  final int promptTokens;
  final int completionTokens;
  final int cachedTokens;
  final int estimatedCalls;
  final int peakPromptTokens;
  final Map<String, ({int calls, int tokens})> bySource;

  int get tokens => promptTokens + completionTokens;

  static Map<String, ({int calls, int tokens})> _sumSources(List<HourUsage> hours) {
    final out = <String, ({int calls, int tokens})>{};
    for (final h in hours) {
      for (final e in h.bySource.entries) {
        final prev = out[e.key] ?? (calls: 0, tokens: 0);
        out[e.key] = (calls: prev.calls + e.value.calls, tokens: prev.tokens + e.value.tokens);
      }
    }
    return out;
  }
}

class ContextUsage {
  ContextUsage({required this.providerName, required this.hours, this.model, this.contextWindow, this.chat, this.autonomous});
  final String providerName;
  final String? model;
  final int? contextWindow;
  final ContextSnapshot? chat;
  final ContextSnapshot? autonomous;
  final List<HourUsage> hours;

  /// The 24 hours of [day] in the phone's own time zone, empty hours included.
  List<HourUsage> hoursOf(DateTime day) {
    // Matched on the local calendar hour, not the exact instant, so a zone with a half-hour offset
    // still lands each server hour on one row.
    final byHour = <int, HourUsage>{};
    for (final h in hours) {
      final l = h.start.toLocal();
      if (l.year == day.year && l.month == day.month && l.day == day.day) byHour[l.hour] = h;
    }
    return [
      for (var i = 0; i < 24; i++)
        byHour[i] ?? HourUsage(start: DateTime(day.year, day.month, day.day, i), calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, estimatedCalls: 0, peakPromptTokens: 0, bySource: const {}),
    ];
  }

  /// Totals per local day for the last [days] days, newest first.
  List<({DateTime day, UsageTotals totals})> daily(DateTime now, int days) => [
        for (var i = 0; i < days; i++)
          (() {
            final d = DateTime(now.year, now.month, now.day - i);
            return (day: d, totals: UsageTotals(hours.where((h) => h.start.year == d.year && h.start.month == d.month && h.start.day == d.day).toList()));
          })(),
      ];

  factory ContextUsage.fromJson(Map<String, dynamic> j) {
    final cur = j['current'] is Map ? Map<String, dynamic>.from(j['current'] as Map) : const <String, dynamic>{};
    return ContextUsage(
      providerName: _str(cur['providerName'], _str(cur['provider'])),
      model: cur['model'] is String ? cur['model'] as String : null,
      contextWindow: _int(cur['contextWindow']),
      chat: ContextSnapshot.fromJson(j['chat']),
      autonomous: ContextSnapshot.fromJson(j['autonomous']),
      hours: _list(j['hours']).map(HourUsage.fromJson).toList(),
    );
  }
}

/// MetaTrader 5 running in Dave's own container (no VPS).
class Mt5View {
  Mt5View({required this.summary, this.agentUrl, this.installed = false, this.running = false, this.login = 'unknown', this.loginDetail, this.configured = false, this.account, this.inputs = const {}, this.lastReportAt});
  final String summary;
  final String? agentUrl;
  final bool installed;
  final bool running;
  final String login; // logged-in | failed | connecting | unknown
  final String? loginDetail;
  final bool configured;
  final ({String login, String server, String symbol, String period})? account;
  final Map<String, String> inputs;
  final DateTime? lastReportAt;

  bool get hasAgent => agentUrl != null;
  int get pushSeconds => int.tryParse(inputs['PushSeconds'] ?? '') ?? 8;

  factory Mt5View.fromJson(Map<String, dynamic> j) {
    final agent = j['agent'] is Map ? Map<String, dynamic>.from(j['agent'] as Map) : null;
    final st = j['status'] is Map ? Map<String, dynamic>.from(j['status'] as Map) : null;
    final acct = st?['account'] is Map ? Map<String, dynamic>.from(st!['account'] as Map) : null;
    final relay = st?['relay'] is Map ? Map<String, dynamic>.from(st!['relay'] as Map) : null;
    final inputs = st?['inputs'] is Map ? Map<String, dynamic>.from(st!['inputs'] as Map) : const <String, dynamic>{};
    return Mt5View(
      summary: _str(j['summary']),
      agentUrl: agent == null ? null : _str(agent['url']),
      installed: st?['installed'] == true,
      running: st?['running'] == true,
      login: _str(st?['login'], 'unknown'),
      loginDetail: st?['loginDetail'] is String ? st!['loginDetail'] as String : null,
      configured: st?['configured'] == true,
      account: acct == null ? null : (login: _str(acct['login']), server: _str(acct['server']), symbol: _str(acct['symbol']), period: _str(acct['period'])),
      inputs: {for (final e in inputs.entries) e.key: '${e.value}'},
      lastReportAt: relay?['lastAt'] is num ? DateTime.fromMillisecondsSinceEpoch(((relay!['lastAt'] as num) * 1000).round()) : null,
    );
  }
}
