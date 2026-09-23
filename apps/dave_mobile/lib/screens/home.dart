import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../app_scope.dart';
import '../theme.dart';
import '../widgets/charts.dart';
import '../widgets/common.dart';

class _HomeData {
  _HomeData(this.dashboard, this.bot);
  final Dashboard dashboard;
  final BotState bot;
}

/// The live dashboard: balance, whether Dave is trading, what is open right now, how it has gone.
///
/// Ordered by what the trader needs first when they pick up the phone between trades: the money,
/// then whether the bot is on, then what is open, then history.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return LoadedPage<_HomeData>(
      title: 'Dave',
      autoRefresh: const Duration(seconds: 15),
      load: (api) async {
        final results = await Future.wait([api.dashboard(), api.bot()]);
        return _HomeData(results[0] as Dashboard, results[1] as BotState);
      },
      builder: (context, data, reload) {
        final d = data.dashboard;
        return [
          SliverToBoxAdapter(child: _BalanceCard(d: d)),
          SliverToBoxAdapter(child: _TradingCard(bot: data.bot, eaConnected: d.eaConnected, onChanged: reload)),
          SliverToBoxAdapter(child: _OpenTrades(d: d)),
          if (d.pendingOrders.isNotEmpty) SliverToBoxAdapter(child: _PendingOrders(orders: d.pendingOrders)),
          SliverToBoxAdapter(child: _Results(d: d)),
          SliverToBoxAdapter(
            child: ContentCard(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const SectionLabel('Last 26 weeks'),
                const SizedBox(height: Space.s3),
                PnlHeatmap(days: d.heatmap),
              ]),
            ),
          ),
        ];
      },
    );
  }
}

class _BalanceCard extends StatelessWidget {
  const _BalanceCard({required this.d});
  final Dashboard d;

  @override
  Widget build(BuildContext context) {
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    if (d.balance == null) {
      return ContentCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const SectionLabel('Balance'),
          const SizedBox(height: Space.s2),
          Text('Waiting for MT5', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700, color: resolve(context, CupertinoColors.tertiaryLabel))),
          const SizedBox(height: Space.s2),
          Text(d.emptyReason ?? 'Connect the MT5 terminal to see a real balance.', style: TextStyle(fontSize: 14, color: secondary)),
        ]),
      );
    }
    final updated = d.accountUpdatedAt;
    return ContentCard(
      padding: const EdgeInsets.fromLTRB(Space.s4, Space.s4, Space.s4, Space.s4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const SectionLabel('Balance'),
        const SizedBox(height: Space.s1),
        // The number is the hero, so it gets the type weight rather than a box around it.
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(
            formatMoney(d.balance!),
            style: const TextStyle(fontSize: 40, fontWeight: FontWeight.w700, letterSpacing: -1.2, fontFeatures: [FontFeature.tabularFigures()]),
          ),
        ),
        if (updated != null) Text('Updated ${formatAgo(updated)}', style: TextStyle(fontSize: 13, color: secondary)),
        const SizedBox(height: Space.s4),
        Row(children: [
          Expanded(child: StatTile(value: d.equity == null ? '--' : formatMoney(d.equity!), label: 'Equity')),
          Expanded(child: StatTile(value: d.freeMargin == null ? '--' : formatMoney(d.freeMargin!), label: 'Free margin')),
          Expanded(
            child: StatTile(
              value: d.positions.isEmpty ? '--' : formatMoney(d.openPnl, signed: true),
              label: 'Open P&L',
              color: d.positions.isEmpty ? null : pnlColor(context, d.openPnl),
            ),
          ),
        ]),
      ]),
    );
  }
}

/// Start / stop, right on the home screen: the most important control in the app should not be
/// two taps deep in settings.
class _TradingCard extends StatefulWidget {
  const _TradingCard({required this.bot, required this.eaConnected, required this.onChanged});
  final BotState bot;
  final bool eaConnected;
  final Future<void> Function() onChanged;

  @override
  State<_TradingCard> createState() => _TradingCardState();
}

class _TradingCardState extends State<_TradingCard> {
  bool? _pending;

  Future<void> _set(bool running) async {
    if (!running) {
      final ok = await confirmDestructive(
        context,
        title: 'Stop autonomous trading?',
        message: 'Dave stops looking for new trades within a few seconds. Open positions are NOT closed -- close them yourself if that is what you want.',
        action: 'Stop trading',
      );
      if (!ok) return;
    }
    if (!mounted) return;
    HapticFeedback.mediumImpact();
    setState(() => _pending = running);
    final scope = AppScope.of(context);
    try {
      await scope.api.updateBot(running: running);
      await widget.onChanged();
    } on UnpairedException catch (e) {
      scope.onUnpaired(e.message);
    } catch (e) {
      if (mounted) await showError(context, e);
    } finally {
      if (mounted) setState(() => _pending = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final running = _pending ?? widget.bot.running;
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final String detail;
    if (!running) {
      detail = 'Not looking for trades.';
    } else if (!widget.bot.executionEnabled) {
      detail = 'Watching only -- asks before opening a trade. Scans every ${widget.bot.intervalMinutes} min.';
    } else {
      detail = 'Looking for trades every ${widget.bot.intervalMinutes} min.';
    }
    return ContentCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Autonomous trading', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
              const SizedBox(height: 2),
              Text(detail, style: TextStyle(fontSize: 13, color: secondary)),
            ]),
          ),
          const SizedBox(width: Space.s3),
          if (_pending != null) const Padding(padding: EdgeInsets.only(right: Space.s2), child: CupertinoActivityIndicator()),
          CupertinoSwitch(value: running, onChanged: _pending != null ? null : _set),
        ]),
        const SizedBox(height: Space.s3),
        Pill(text: widget.eaConnected ? 'MT5 connected' : 'MT5 not connected', good: widget.eaConnected),
      ]),
    );
  }
}

class _OpenTrades extends StatelessWidget {
  const _OpenTrades({required this.d});
  final Dashboard d;

  @override
  Widget build(BuildContext context) {
    final header = d.maxOpenTrades == null ? 'Open trades' : 'Open trades  ${d.positions.length} of ${d.maxOpenTrades}';
    if (d.positions.isEmpty) {
      return CupertinoListSection.insetGrouped(
        header: ListHeader(header),
        children: const [
          CupertinoListTile(
            leading: Icon(CupertinoIcons.moon_zzz),
            title: Text('Nothing open right now'),
            subtitle: Text('New trades appear here the moment they open.'),
          ),
        ],
      );
    }
    return CupertinoListSection.insetGrouped(
      header: ListHeader(header),
      children: [for (final p in d.positions) _PositionTile(p: p)],
    );
  }
}

class _PositionTile extends StatelessWidget {
  const _PositionTile({required this.p});
  final Position p;

  @override
  Widget build(BuildContext context) {
    final levels = [
      '${p.lots} lots at ${formatPrice(p.openPrice)}',
      if (p.sl != null) 'SL ${formatPrice(p.sl!)}',
      if (p.tp != null) 'TP ${formatPrice(p.tp!)}',
    ].join('  ·  ');
    return CupertinoListTile(
      leading: Icon(p.isBuy ? CupertinoIcons.arrow_up_right : CupertinoIcons.arrow_down_right, color: resolve(context, CupertinoColors.secondaryLabel)),
      title: Text('${p.symbol}  ${p.isBuy ? 'Buy' : 'Sell'}'),
      subtitle: Text(levels),
      trailing: Text(
        p.pnl == null ? '--' : formatMoney(p.pnl!, signed: true),
        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: pnlColor(context, p.pnl), fontFeatures: const [FontFeature.tabularFigures()]),
      ),
    );
  }
}

class _PendingOrders extends StatelessWidget {
  const _PendingOrders({required this.orders});
  final List<PendingOrder> orders;

  @override
  Widget build(BuildContext context) => CupertinoListSection.insetGrouped(
        header: ListHeader('PENDING ORDERS  ${orders.length}'),
        children: [
          for (final o in orders)
            CupertinoListTile(
              leading: Icon(CupertinoIcons.clock, color: resolve(context, CupertinoColors.secondaryLabel)),
              title: Text('${o.symbol}  ${o.label}'),
              subtitle: Text('${o.lots} lots at ${formatPrice(o.price)}'),
            ),
        ],
      );
}

class _Results extends StatelessWidget {
  const _Results({required this.d});
  final Dashboard d;

  @override
  Widget build(BuildContext context) => ContentCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const SectionLabel('Results'),
          const SizedBox(height: Space.s3),
          Row(children: [
            Expanded(child: StatTile(value: d.winRatePercent == null ? '--' : '${d.winRatePercent}%', label: 'Win rate')),
            Expanded(child: StatTile(value: '${d.wins}/${d.losses}', label: 'Won / lost')),
            Expanded(
              child: StatTile(
                value: d.closedTrades == 0 ? '--' : formatMoney(d.realisedPnl, signed: true),
                label: 'Realised',
                color: d.closedTrades == 0 ? null : pnlColor(context, d.realisedPnl),
              ),
            ),
          ]),
        ]),
      );
}
