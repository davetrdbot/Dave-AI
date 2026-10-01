import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../app_scope.dart';
import '../push/push_service.dart';
import '../session.dart';
import 'dave_voice.dart';
import 'thinking_steps.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/pickers.dart';
import 'context.dart';
import 'extras.dart';
import 'mt5.dart';
import 'nous.dart';
import 'providers.dart';
import '../look.dart';

class _SettingsData {
  _SettingsData(this.bot, this.settings, this.providers, this.notifications, this.serviceRunning, this.batteryExempt);
  final BotState bot;
  final AppSettings settings;
  final ProviderList providers;
  final bool notifications;
  final bool serviceRunning;
  final bool batteryExempt;
}

/// Every bot setting, grouped the way a trader thinks about them: trading on/off, risk, which
/// markets, how Dave behaves, which alerts, the AI, and this phone.
///
/// Each control writes through the same setter the Telegram /settings screens use, so the two can
/// never disagree -- change something here and /settings in Telegram shows it, and vice versa.
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return LoadedPage<_SettingsData>(
      title: 'Settings',
      load: _loadSettings,
      builder: (context, data, reload) {
        Future<void> open(String title, List<Widget> Function(BuildContext, _SettingsData, Future<void> Function()) sections) async {
          await pushScoped<void>(context, _GroupPage(title: title, sections: sections));
          await reload();
        }

        final s = data.settings;
        final group = s.pairGroups.where((g) => g.id == s.pairGroup).firstOrNull;
        return [
          SliverToBoxAdapter(child: _TradingSwitchCard(bot: data.bot, reload: reload)),
          SliverToBoxAdapter(
            child: _menu(context, 'Trading', [
              _MenuRow(CupertinoIcons.chart_bar_alt_fill, 'Trading & markets', 'Scan speed, session, pairs (${group?.name ?? 'none'}), what Dave analyses',
                  () => open('Trading & markets', (c, d, r) => [_TradingSection(bot: d.bot, reload: r), _MarketsSection(s: d.settings, reload: r), const _MarketsLinks()])),
              _MenuRow(CupertinoIcons.shield_lefthalf_fill, 'Risk', 'Risk:reward 1:${_num(s.riskReward.value)} · confidence ${s.confidence.value.round()}% · SL, TP, lots, limits',
                  () => open('Risk', (c, d, r) => [
                        RiskModeCard(id: 'stopLoss', title: 'Stop loss', icon: CupertinoIcons.shield, mode: d.settings.stopLoss, onChanged: r),
                        RiskModeCard(id: 'takeProfit', title: 'Take profit', icon: CupertinoIcons.flag, mode: d.settings.takeProfit, onChanged: r),
                        RiskModeCard(id: 'lotSize', title: 'Lot size', icon: CupertinoIcons.cube_box, mode: d.settings.lotSize, onChanged: r),
                        _RiskSection(s: d.settings, reload: r),
                      ])),
              _MenuRow(CupertinoIcons.hourglass, 'Waiting on', 'Setups, reminders and levels Dave set', () => pushScoped<void>(context, const WatchlistPage())),
            ]),
          ),
          SliverToBoxAdapter(
            child: _menu(context, 'Dave', [
              _MenuRow(CupertinoIcons.sparkles, 'AI & models', data.providers.main == null ? 'No main AI yet' : 'Main: ${data.providers.main!.name}',
                  () => open('AI & models', (c, d, r) => [_AiSection(s: d.settings, providers: d.providers, reload: r)])),
              _MenuRow(CupertinoIcons.person_crop_circle_badge_checkmark, 'How Dave behaves', 'Self-pause, two-step, deeper thinking, memory',
                  () => open('How Dave behaves', (c, d, r) => [_BehaviourSection(s: d.settings, reload: r)])),
              _MenuRow(CupertinoIcons.doc_text, 'Dave\'s prompt', 'Read and edit how Dave thinks and trades', () => pushScoped<void>(context, const PromptPage())),
              _MenuRow(CupertinoIcons.gauge, 'Context & usage', 'How full Dave\'s context is, and today\'s AI use', () => pushScoped<void>(context, const ContextScreen())),
            ]),
          ),
          SliverToBoxAdapter(
            child: _menu(context, 'Connections', [
              _MenuRow(CupertinoIcons.desktopcomputer, 'MetaTrader 5', 'Account, chart, switch account, restart', () => pushScoped<void>(context, const Mt5Page())),
              _MenuRow(CupertinoIcons.slider_horizontal_3, 'EA settings', 'Report speed, slippage, magic number, zones', () => pushScoped<void>(context, const EaSettingsPage())),
              _MenuRow(CupertinoIcons.antenna_radiowaves_left_right, 'Nous copy trading', 'Copy signals from your Telegram channels', () => pushScoped<void>(context, const NousPage())),
              _MenuRow(CupertinoIcons.lock, 'Service keys', 'E2B (scripts) and Firecrawl (web pages)', () => pushScoped<void>(context, const ServiceKeysPage())),
              _MenuRow(CupertinoIcons.cube, 'MCP servers', 'Extra tools Dave can connect to', () => pushScoped<void>(context, const McpPage())),
            ]),
          ),
          SliverToBoxAdapter(
            child: _menu(context, 'Alerts', [
              _MenuRow(CupertinoIcons.bell, 'Alerts & notifications', '${s.alerts.where((a) => a.on).length} of ${s.alerts.length} Telegram alerts on · phone ${data.notifications ? 'on' : 'off'}',
                  () => open('Alerts & notifications', (c, d, r) => [_AlertsSection(s: d.settings, reload: r), _NotificationSection(data: d, reload: r)])),
            ]),
          ),
          const SliverToBoxAdapter(child: _AppearanceSection()),
          const SliverToBoxAdapter(child: _ConnectionSection()),
        ];
      },
    );
  }
}

Future<_SettingsData> _loadSettings(DaveApi api) async {
  final results = await Future.wait([api.bot(), api.settings(), api.providers()]);
  return _SettingsData(
    results[0] as BotState,
    results[1] as AppSettings,
    results[2] as ProviderList,
    await Session.notificationsEnabled(),
    await PushService.isRunning,
    await PushService.isIgnoringBatteryOptimizations,
  );
}

/// One group of settings on its own screen, loaded fresh so it always shows what is stored.
class _GroupPage extends StatelessWidget {
  const _GroupPage({required this.title, required this.sections});
  final String title;
  final List<Widget> Function(BuildContext, _SettingsData, Future<void> Function()) sections;

  @override
  Widget build(BuildContext context) => LoadedPage<_SettingsData>(
        title: title,
        load: _loadSettings,
        builder: (context, data, reload) => [for (final w in sections(context, data, reload)) SliverToBoxAdapter(child: w)],
      );
}

class _MenuRow {
  const _MenuRow(this.icon, this.title, this.subtitle, this.onTap);
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
}

Widget _menu(BuildContext context, String header, List<_MenuRow> rows) => CupertinoListSection.insetGrouped(
      backgroundColor: const Color(0x00000000),
      decoration: glassDecoration(context, radius: 14),
      separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4),
      header: ListHeader(header),
      children: [
        for (final r in rows)
          CupertinoListTile(
            leading: Container(
              width: 30,
              height: 30,
              decoration: BoxDecoration(color: Look.of(context).accent.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(8)),
              child: Icon(r.icon, size: 17, color: Look.of(context).accent),
            ),
            title: Text(r.title),
            subtitle: Text(r.subtitle, maxLines: 1, overflow: TextOverflow.ellipsis),
            trailing: const CupertinoListTileChevron(),
            onTap: r.onTap,
          ),
      ],
    );

/// The one switch that matters most, at the top of Settings where nobody can miss it: is Dave
/// actually hunting for trades right now.
class _TradingSwitchCard extends StatelessWidget {
  const _TradingSwitchCard({required this.bot, required this.reload});
  final BotState bot;
  final Future<void> Function() reload;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final on = bot.running;
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.s4, Space.s2, Space.s4, 0),
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 14, 12, 14),
        decoration: on ? BoxDecoration(gradient: look.hero, borderRadius: BorderRadius.circular(18)) : glassDecoration(context, radius: 18),
        child: Row(children: [
          Container(
            width: 10,
            height: 10,
            decoration: BoxDecoration(shape: BoxShape.circle, color: on ? look.up : look.down),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(on ? 'Dave is trading' : 'Trading is OFF',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: on ? look.heroText : resolve(context, CupertinoColors.label))),
              const SizedBox(height: 2),
              Text(
                on ? (bot.executionEnabled ? 'Scanning every ${bot.intervalMinutes} min and placing trades' : 'Scanning, but asking you before each trade') : 'Dave is not scanning or placing trades',
                style: TextStyle(fontSize: 13, color: on ? look.heroText.withValues(alpha: 0.75) : resolve(context, CupertinoColors.secondaryLabel)),
              ),
            ]),
          ),
          CupertinoSwitch(
            activeTrackColor: look.accent,
            value: on,
            onChanged: (v) async {
              if (!v) {
                final ok = await confirmDestructive(context, title: 'Stop autonomous trading?', message: 'Open positions are not closed.', action: 'Stop trading');
                if (!ok) return;
              }
              if (context.mounted) await _guarded(context, (api) => api.updateBot(running: v), reload);
            },
          ),
        ]),
      ),
    );
  }
}

/// Pair groups and analysis scope, under the markets section.
class _MarketsLinks extends StatelessWidget {
  const _MarketsLinks();

  @override
  Widget build(BuildContext context) => _menu(context, 'Edit', [
        _MenuRow(CupertinoIcons.square_grid_2x2, 'Pair groups', 'Create and edit the groups of symbols Dave hunts', () => pushScoped<void>(context, const PairGroupsPage())),
        _MenuRow(CupertinoIcons.scope, 'What Dave analyses', 'Timeframes and analysis types per scan', () => pushScoped<void>(context, const AnalysisScopePage())),
      ]);
}

Future<void> _guarded(BuildContext context, Future<void> Function(DaveApi api) action, Future<void> Function() reload) async {
  if (await runAction(context, action)) await reload();
}

/// Changes one server-side setting, then reloads so the screen shows what was actually stored.
Future<void> _set(BuildContext context, String id, Object? value, Future<void> Function() reload) =>
    _guarded(context, (api) => api.updateSetting(id, value), reload);

String _num(double v) => v == v.roundToDouble() ? v.toStringAsFixed(0) : (v * 10 == (v * 10).roundToDouble() ? v.toStringAsFixed(1) : v.toStringAsFixed(2));

// ---------------------------------------------------------------------------------------------

/// Midnight Lime (dark) or Pearl (light) -- the whole app switches at once and the choice is
/// remembered on this phone.
class _AppearanceSection extends StatelessWidget {
  const _AppearanceSection();

  @override
  Widget build(BuildContext context) {
    final current = Look.of(context);
    final controller = LookScope.controllerOf(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.s4, Space.s2, Space.s4, 0),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Padding(padding: EdgeInsets.fromLTRB(Space.s4, Space.s3, 0, Space.s2), child: ListHeader('Appearance')),
        Row(children: [
          for (final (i, look) in Look.all.indexed) ...[
            if (i > 0) const SizedBox(width: 10),
            Expanded(
              child: GestureDetector(
                onTap: () {
                  HapticFeedback.selectionClick();
                  controller?.choose(look);
                },
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 200),
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: look.base,
                    borderRadius: BorderRadius.circular(22),
                    border: Border.all(color: look.id == current.id ? current.accent : current.line, width: look.id == current.id ? 2.5 : 1),
                  ),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    // A tiny preview: a card, the accent, and the round bar.
                    Container(
                      height: 54,
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(color: look.card, borderRadius: BorderRadius.circular(14), border: Border.all(color: look.line)),
                      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Container(height: 6, width: 34, decoration: BoxDecoration(color: look.dark ? const Color(0x44FFFFFF) : const Color(0x33000000), borderRadius: BorderRadius.circular(3))),
                            const SizedBox(height: 6),
                            Container(height: 12, width: 60, decoration: BoxDecoration(color: look.dark ? const Color(0xEEFFFFFF) : const Color(0xFF141414), borderRadius: BorderRadius.circular(4))),
                          ]),
                        ),
                        Container(width: 16, height: 16, decoration: BoxDecoration(color: look.accent, shape: BoxShape.circle)),
                      ]),
                    ),
                    const SizedBox(height: 8),
                    Container(
                      padding: const EdgeInsets.all(4),
                      decoration: BoxDecoration(color: look.bar, borderRadius: BorderRadius.circular(14)),
                      child: Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
                        for (var k = 0; k < 4; k++)
                          Container(width: 14, height: 14, decoration: BoxDecoration(color: k == 0 ? look.tabActive : look.tabIdle, shape: BoxShape.circle)),
                      ]),
                    ),
                    const SizedBox(height: 10),
                    Row(children: [
                      Expanded(
                        child: Text(look.name,
                            style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: look.dark ? const Color(0xFFF4F5F0) : const Color(0xFF141414))),
                      ),
                      if (look.id == current.id) Icon(CupertinoIcons.checkmark_circle_fill, size: 18, color: look.accent),
                    ]),
                    Text(look.dark ? 'Dark' : 'Light', style: TextStyle(fontSize: 12, color: look.dark ? const Color(0xFF8A8F86) : const Color(0xFF8A857C))),
                  ]),
                ),
              ),
            ),
          ],
        ]),
      ]),
    );
  }
}

class _TradingSection extends StatelessWidget {
  const _TradingSection({required this.bot, required this.reload});
  final BotState bot;
  final Future<void> Function() reload;

  @override
  Widget build(BuildContext context) => CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
        header: const ListHeader('Trading'),
        footer: const ListFooter('Watch-only keeps Dave analysing and managing open trades, but he asks you before opening a new one. Stopping never closes open positions.'),
        children: [
          CupertinoListTile(
            leading: const Icon(CupertinoIcons.play_circle),
            title: const Text('Autonomous trading'),
            trailing: CupertinoSwitch(activeTrackColor: Look.of(context).accent, 
              value: bot.running,
              onChanged: (v) async {
                if (!v) {
                  final ok = await confirmDestructive(context, title: 'Stop autonomous trading?', message: 'Open positions are not closed.', action: 'Stop trading');
                  if (!ok) return;
                }
                if (context.mounted) await _guarded(context, (api) => api.updateBot(running: v), reload);
              },
            ),
          ),
          CupertinoListTile(
            leading: const Icon(CupertinoIcons.bolt),
            title: const Text('Take trades'),
            subtitle: Text(bot.executionEnabled ? 'Automatically' : 'Watch-only, asks you first'),
            trailing: CupertinoSwitch(activeTrackColor: Look.of(context).accent, value: bot.executionEnabled, onChanged: (v) => _guarded(context, (api) => api.updateBot(executionEnabled: v), reload)),
          ),
          CupertinoListTile(
            leading: const Icon(CupertinoIcons.timer),
            title: const Text('Scan every'),
            trailing: _Stepper(
              text: '${bot.intervalMinutes} min',
              onMinus: bot.intervalMinutes <= bot.minInterval ? null : () => _guarded(context, (api) => api.updateBot(intervalMinutes: bot.intervalMinutes - 1), reload),
              onPlus: bot.intervalMinutes >= bot.maxInterval ? null : () => _guarded(context, (api) => api.updateBot(intervalMinutes: bot.intervalMinutes + 1), reload),
              less: 'Scan less often',
              more: 'Scan more often',
            ),
          ),
        ],
      );
}

class _RiskSection extends StatelessWidget {
  const _RiskSection({required this.s, required this.reload});
  final AppSettings s;
  final Future<void> Function() reload;

  @override
  Widget build(BuildContext context) {
    final rr = s.riskReward.value;
    final conf = s.confidence.value.round();
    return CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
      header: const ListHeader('Risk'),
      footer: const ListFooter('Take profit is placed at exactly this multiple of the stop distance (unless TP is fixed in pips). Below the confidence level he asks you first, unless auto-approve is on.'),
      children: [
        CupertinoListTile(
          leading: const Icon(CupertinoIcons.arrow_up_right_circle),
          title: const Text('Risk:reward'),
          subtitle: const Text('Tap to type any value, e.g. 1.5'),
          additionalInfo: Text('1:${_num(rr)}'),
          trailing: const CupertinoListTileChevron(),
          onTap: () async {
            final text = await promptText(
              context,
              title: 'Risk:reward',
              message: 'Take profit is placed at exactly this many times the stop distance. Buy at 100 with the stop at 98 and 3.5 gives a take profit at 107.',
              initial: _num(rr),
              placeholder: 'e.g. 1.5',
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
            );
            final v = double.tryParse((text ?? '').replaceAll(',', '.'));
            if (v == null || !context.mounted) return;
            if (v < s.riskReward.min || v > s.riskReward.max) return showError(context, 'Use a number from ${_num(s.riskReward.min)} to ${_num(s.riskReward.max)}.');
            await _set(context, 'riskReward', v, reload);
          },
        ),
        CupertinoListTile(
          leading: const Icon(CupertinoIcons.gauge),
          title: const Text('Confidence'),
          trailing: _Stepper(
            text: '$conf%',
            onMinus: conf - 5 < 0 ? null : () => _set(context, 'confidenceThreshold', conf - 5, reload),
            onPlus: conf + 5 > 100 ? null : () => _set(context, 'confidenceThreshold', conf + 5, reload),
            less: 'Lower confidence needed',
            more: 'Raise confidence needed',
          ),
        ),
        CupertinoListTile(
          leading: const Icon(CupertinoIcons.checkmark_seal),
          title: const Text('Auto-approve below it'),
          subtitle: Text(s.autoApproveBelowThreshold ? 'Trades anyway' : 'Asks you to approve'),
          trailing: CupertinoSwitch(activeTrackColor: Look.of(context).accent, value: s.autoApproveBelowThreshold, onChanged: (v) => _set(context, 'autoApproveBelowThreshold', v, reload)),
        ),
        CupertinoListTile(
          leading: const Icon(CupertinoIcons.square_stack),
          title: const Text('Max trades'),
          trailing: _Stepper(
            text: s.maxOpenTrades == null ? 'No limit' : '${s.maxOpenTrades}',
            onMinus: (s.maxOpenTrades ?? 1) <= 1 ? null : () => _set(context, 'maxOpenTrades', s.maxOpenTrades! - 1, reload),
            onPlus: (s.maxOpenTrades ?? 0) >= 50 ? null : () => _set(context, 'maxOpenTrades', (s.maxOpenTrades ?? 0) + 1, reload),
            less: 'Fewer open trades',
            more: 'More open trades',
          ),
        ),
        CupertinoListTile(
          leading: const Icon(CupertinoIcons.arrow_down_circle),
          title: const Text('Max daily loss'),
          additionalInfo: Text(s.maxDailyLossPct == null ? 'No limit' : '${_num(s.maxDailyLossPct!)}%'),
          trailing: const CupertinoListTileChevron(),
          onTap: () async {
            final text = await promptText(
              context,
              title: 'Max daily loss',
              message: 'Dave stops trading for the day once the account is down this much (percent of balance).',
              initial: s.maxDailyLossPct == null ? '' : _num(s.maxDailyLossPct!),
              placeholder: 'e.g. 5',
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
            );
            final v = double.tryParse(text ?? '');
            if (v != null && context.mounted) await _set(context, 'maxDailyLossPct', v, reload);
          },
        ),
      ],
    );
  }

}

/// Off / fixed value / Dave decides, for stop loss, take profit or lot size.
class RiskModePage extends StatefulWidget {
  const RiskModePage({super.key, required this.id, required this.title, required this.mode});
  final String id;
  final String title;
  final RiskMode mode;

  @override
  State<RiskModePage> createState() => RiskModePageState();
}

class RiskModePageState extends State<RiskModePage> {
  late String _mode = widget.mode.mode;
  late final _value = TextEditingController(text: widget.mode.value == null ? '' : _num(widget.mode.value!));
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _value.dispose();
    super.dispose();
  }

  String get _unit => widget.mode.unit.isEmpty ? (widget.id == 'lotSize' ? 'lots' : 'pips') : widget.mode.unit;

  Future<void> _save() async {
    double? v;
    if (_mode == 'on') {
      v = double.tryParse(_value.text.trim());
      if (v == null || v <= 0) {
        setState(() => _error = 'Enter a number above zero.');
        return;
      }
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final ok = await runAction(context, (api) => api.updateSetting(widget.id, {'mode': _mode, 'value': ?v}));
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    final explain = switch (_mode) {
      'on' => 'Every trade uses exactly this ${widget.title.toLowerCase()}.',
      'auto' => 'Dave sets the ${widget.title.toLowerCase()} for each trade from his analysis.',
      _ => 'No ${widget.title.toLowerCase()} rule -- Dave uses his normal judgement and it is not enforced.',
    };
    return CupertinoPageScaffold(
      backgroundColor: const Color(0x00000000),
      navigationBar: CupertinoNavigationBar(
        middle: Text(widget.title),
        trailing: CupertinoButton(padding: EdgeInsets.zero, onPressed: _busy ? null : _save, child: _busy ? const CupertinoActivityIndicator() : const Text('Save', style: TextStyle(fontWeight: FontWeight.w600))),
      ),
      child: SafeArea(
        child: ListView(padding: const EdgeInsets.all(Space.s4), children: [
          CupertinoSlidingSegmentedControl<String>(
            groupValue: _mode,
            children: const {
              'off': Padding(padding: EdgeInsets.symmetric(vertical: 6), child: Text('Off')),
              'on': Padding(padding: EdgeInsets.symmetric(vertical: 6), child: Text('Fixed')),
              'auto': Padding(padding: EdgeInsets.symmetric(vertical: 6), child: Text('Dave decides')),
            },
            onValueChanged: (v) => setState(() => _mode = v ?? _mode),
          ),
          const SizedBox(height: Space.s3),
          Padding(padding: const EdgeInsets.symmetric(horizontal: Space.s2), child: ListFooter(explain)),
          if (_mode == 'on') ...[
            const SizedBox(height: Space.s4),
            CupertinoTextField(
              controller: _value,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              placeholder: widget.id == 'lotSize' ? '0.01' : '30',
              suffix: Padding(padding: const EdgeInsets.only(right: Space.s3), child: Text(_unit, style: TextStyle(color: resolve(context, CupertinoColors.secondaryLabel)))),
              padding: const EdgeInsets.all(Space.s3),
              decoration: BoxDecoration(color: resolve(context, CupertinoColors.secondarySystemGroupedBackground), borderRadius: BorderRadius.circular(10)),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: Space.s3),
            Text(_error!, style: TextStyle(fontSize: 14, color: Look.of(context).down)),
          ],
        ]),
      ),
    );
  }
}

class _MarketsSection extends StatelessWidget {
  const _MarketsSection({required this.s, required this.reload});
  final AppSettings s;
  final Future<void> Function() reload;

  static const _sessionNames = {'all': 'All sessions', 'sydney': 'Sydney', 'asian': 'Asian', 'london': 'London', 'new_york': 'New York'};

  @override
  Widget build(BuildContext context) {
    final group = s.pairGroups.where((g) => g.id == s.pairGroup).firstOrNull;
    return CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
      header: const ListHeader('Markets'),
      footer: const ListFooter('Dave only looks for new trades in this session, on the pairs in this group.'),
      children: [
        CupertinoListTile(
          leading: const Icon(CupertinoIcons.globe),
          title: const Text('Trading session'),
          additionalInfo: Text(_sessionNames[s.session] ?? s.session),
          trailing: const CupertinoListTileChevron(),
          onTap: () => _pick(context, 'Trading session', [for (final id in s.sessions) (id, _sessionNames[id] ?? id, null)], s.session, 'session'),
        ),
        CupertinoListTile(
          leading: const Icon(CupertinoIcons.chart_bar_alt_fill),
          title: const Text('Pairs'),
          additionalInfo: Text(group?.name ?? 'None'),
          trailing: const CupertinoListTileChevron(),
          onTap: () => _pick(context, 'Pairs', [for (final g in s.pairGroups) (g.id, g.name, '${g.symbols} pairs')], s.pairGroup, 'pairGroup'),
        ),
      ],
    );
  }

  Future<void> _pick(BuildContext context, String title, List<(String, String, String?)> options, String? current, String id) async {
    final changed = await pushScoped<bool>(context, _PickerPage(title: title, options: options, current: current, settingId: id));
    if (changed == true) await reload();
  }
}

/// A single-choice list: tap to choose, a checkmark on the current one.
class _PickerPage extends StatelessWidget {
  const _PickerPage({required this.title, required this.options, required this.current, required this.settingId});
  final String title;
  final List<(String, String, String?)> options; // id, name, detail
  final String? current;
  final String settingId;

  @override
  Widget build(BuildContext context) => CupertinoPageScaffold(
        backgroundColor: const Color(0x00000000),
        navigationBar: CupertinoNavigationBar(middle: Text(title)),
        child: SafeArea(
          child: ListView(children: [
            CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
              children: [
                for (final o in options)
                  CupertinoListTile(
                    title: Text(o.$2),
                    subtitle: o.$3 == null ? null : Text(o.$3!),
                    trailing: o.$1 == current ? Icon(CupertinoIcons.checkmark_alt, color: Look.of(context).accent) : null,
                    onTap: () async {
                      if (o.$1 == current) return Navigator.of(context).pop(false);
                      if (await runAction(context, (api) => api.updateSetting(settingId, o.$1)) && context.mounted) Navigator.of(context).pop(true);
                    },
                  ),
              ],
            ),
          ]),
        ),
      );
}

class _BehaviourSection extends StatelessWidget {
  const _BehaviourSection({required this.s, required this.reload});
  final AppSettings s;
  final Future<void> Function() reload;

  Widget _toggle(BuildContext context, String id, IconData icon, String title, String subtitle, bool value) => CupertinoListTile(
        leading: Icon(icon),
        title: Text(title),
        subtitle: Text(subtitle),
        trailing: CupertinoSwitch(activeTrackColor: Look.of(context).accent, value: value, onChanged: (v) => _set(context, id, v, reload)),
      );

  @override
  Widget build(BuildContext context) => CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
        header: const ListHeader('How Dave works'),
        children: [
          _toggle(context, 'telegramSilent', CupertinoIcons.bell_slash, 'Silence Telegram', s.telegramSilent ? 'Off in Telegram; app only' : 'Dave also messages on Telegram', s.telegramSilent),
          _toggle(context, 'autoDrawTrades', CupertinoIcons.scribble, 'Draw my trades', 'Each new trade drawn in chat', s.autoDrawTrades),
          _toggle(context, 'selfPause', CupertinoIcons.pause_circle, 'Self-pause', 'Dave may pause himself in bad conditions', s.selfPause),
          _toggle(context, 'twoStepTrading', CupertinoIcons.person_2, 'Two-step trading', 'A second AI reviews every trade first', s.twoStepTrading),
          _toggle(context, 'sequentialThinking', CupertinoIcons.list_number, 'Deeper thinking', 'Step-by-step trade decisions; slower, costs more', s.sequentialThinking),
          if (s.sequentialThinking) _EffortRow(effort: s.sequentialThinkingEffort, onPick: (e) => _set(context, 'sequentialThinkingEffort', e, reload)),
          if (s.sequentialThinking)
            CupertinoListTile(
              key: const ValueKey('thinking-steps'),
              leading: const Icon(CupertinoIcons.tag),
              title: const Text('Thinking steps'),
              subtitle: const Text('Turn steps on or off, delete, add your own'),
              trailing: const CupertinoListTileChevron(),
              onTap: () => Navigator.of(context).push(CupertinoPageRoute<void>(builder: (_) => const ThinkingStepsPage())),
            ),
          if (s.sequentialThinking)
            _toggle(context, 'thinkOnAlertScans', CupertinoIcons.bell, 'Think on alert scans', s.thinkOnAlertScans ? 'Alerts and reminders get the full thinking pass' : 'Alerts and reminders go straight to a decision', s.thinkOnAlertScans),
          _toggle(context, 'autoApproval', CupertinoIcons.slider_horizontal_3, 'Let Dave change limits', 'Approves his own limit changes without asking', s.autoApproval),
          _toggle(context, 'memoryWriteApproval', CupertinoIcons.lock_shield, 'Approve memory writes', 'Dave asks before saving to memory', s.memoryWriteApproval),
        ],
      );
}

class _AlertsSection extends StatelessWidget {
  const _AlertsSection({required this.s, required this.reload});
  final AppSettings s;
  final Future<void> Function() reload;

  @override
  Widget build(BuildContext context) {
    final on = s.alerts.where((a) => a.on).length;
    return CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
      header: const ListHeader('Trade alerts in Telegram'),
      footer: const ListFooter('Stop-loss warnings: how far a losing trade gets toward its stop before Dave warns you -- one warning per row. Reviews: when an alert needs a decision, Dave checks fresh candles against the idea and gives a verdict.'),
      children: [
        CupertinoListTile(
          key: const ValueKey('sl-ladder'),
          leading: const Icon(CupertinoIcons.exclamationmark_triangle),
          title: const Text('Stop-loss warnings'),
          additionalInfo: Text('${s.slAlertLevels.join(' · ')}%'),
          trailing: const CupertinoListTileChevron(),
          onTap: () async {
            await pushScoped<void>(context, _SlLadderPage(initial: s.slAlertLevels, maxRows: s.slAlertMaxRows));
            await reload();
          },
        ),
        _ReviewModeRow(mode: s.selfAwareMode, onPick: (m) => _set(context, 'selfAwareMode', m, reload)),
        CupertinoListTile(
          leading: const Icon(CupertinoIcons.eye),
          title: const Text('Self-aware alerts'),
          additionalInfo: Text('$on of ${s.alerts.length} on'),
          trailing: const CupertinoListTileChevron(),
          onTap: () async {
            await pushScoped<void>(context, _AlertsPage(initial: s.alerts));
            await reload();
          },
        ),
      ],
    );
  }
}

/// One switch per self-aware alert. Each flips immediately; the list is the server's own.
/// The stop-loss warning ladder: one row per level, add and delete rows.
class _SlLadderPage extends StatefulWidget {
  const _SlLadderPage({required this.initial, required this.maxRows});
  final List<int> initial;
  final int maxRows;

  @override
  State<_SlLadderPage> createState() => _SlLadderPageState();
}

class _SlLadderPageState extends State<_SlLadderPage> {
  late var _levels = [...widget.initial];

  Future<void> _save(List<int> next) async {
    final api = AppScope.of(context).api;
    final ok = await runAction(context, (_) async {
      final updated = await api.updateSetting('slAlertLevels', next);
      if (mounted) setState(() => _levels = [...updated.slAlertLevels]);
    });
    if (!ok && mounted) setState(() {});
  }

  void _change(int i, int delta) {
    final next = [..._levels];
    next[i] = (next[i] + delta).clamp(5, 99);
    _save(next);
  }

  /// Type an exact level (50 -> 74 without tapping + 24 times).
  Future<void> _type(int i) async {
    final ctrl = TextEditingController(text: '${_levels[i]}');
    final v = await showCupertinoDialog<int>(
      context: context,
      builder: (c) => CupertinoAlertDialog(
        title: Text(i == 0 ? 'Deep loss' : 'Warning ${i + 1}'),
        content: Padding(
          padding: const EdgeInsets.only(top: 10),
          child: CupertinoTextField(
            key: const ValueKey('sl-type'),
            controller: ctrl,
            autofocus: true,
            keyboardType: TextInputType.number,
            suffix: const Padding(padding: EdgeInsets.only(right: 8), child: Text('%')),
          ),
        ),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          CupertinoDialogAction(isDefaultAction: true, onPressed: () => Navigator.pop(c, int.tryParse(ctrl.text.trim())), child: const Text('Save')),
        ],
      ),
    );
    if (v == null || !mounted) return;
    final next = [..._levels];
    next[i] = v.clamp(5, 99);
    await _save(next);
  }

  void _add() {
    final top = _levels.isEmpty ? 45 : _levels.last;
    var v = (top + 5).clamp(5, 99);
    while (_levels.contains(v) && v > 5) {
      v -= 1;
    }
    _save([..._levels, v]);
  }

  @override
  Widget build(BuildContext context) {
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    return CupertinoPageScaffold(
      backgroundColor: const Color(0x00000000),
      navigationBar: const CupertinoNavigationBar(middle: Text('Stop-loss warnings')),
      child: SafeArea(
        child: ListView(children: [
          CupertinoListSection.insetGrouped(
            backgroundColor: const Color(0x00000000),
            decoration: glassDecoration(context, radius: 14),
            separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4),
            header: const ListHeader('Warn me when a losing trade is'),
            footer: const ListFooter('Percent of the way from the entry to the stop loss. Each row warns once per losing stretch; the first row is the deep-loss warning, and rows at 85%+ read as "nearly stopped out".'),
            children: [
              for (var i = 0; i < _levels.length; i++)
                CupertinoListTile(
                  key: ValueKey('sl-row-$i'),
                  leading: CupertinoButton(
                    key: ValueKey('sl-delete-$i'),
                    padding: EdgeInsets.zero,
                    minimumSize: const Size(28, 28),
                    onPressed: _levels.length <= 1 ? null : () => _save([..._levels]..removeAt(i)),
                    child: Icon(CupertinoIcons.minus_circle_fill, color: _levels.length <= 1 ? secondary : resolve(context, CupertinoColors.systemRed)),
                  ),
                  title: Text(i == 0 ? 'Deep loss' : 'Warning ${i + 1}'),
                  subtitle: const Text('Tap to type a number'),
                  onTap: () => _type(i),
                  trailing: _Stepper(
                    text: '${_levels[i]}%',
                    onMinus: _levels[i] <= 5 ? null : () => _change(i, -1),
                    onPlus: _levels[i] >= 99 ? null : () => _change(i, 1),
                    less: 'Earlier',
                    more: 'Later',
                  ),
                ),
              if (_levels.length < widget.maxRows)
                CupertinoListTile(
                  key: const ValueKey('sl-add'),
                  leading: Icon(CupertinoIcons.plus_circle_fill, color: resolve(context, CupertinoColors.systemGreen)),
                  title: const Text('Add a warning'),
                  onTap: _add,
                ),
            ],
          ),
        ]),
      ),
    );
  }
}

class _AlertsPage extends StatefulWidget {
  const _AlertsPage({required this.initial});
  final List<AlertToggle> initial;

  @override
  State<_AlertsPage> createState() => _AlertsPageState();
}

class _AlertsPageState extends State<_AlertsPage> {
  late var _alerts = widget.initial;

  @override
  Widget build(BuildContext context) => CupertinoPageScaffold(
        backgroundColor: const Color(0x00000000),
        navigationBar: const CupertinoNavigationBar(middle: Text('Self-aware alerts')),
        child: SafeArea(
          child: ListView(children: [
            CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
              footer: const ListFooter('What Dave tells you about an open trade as it develops. These go to Telegram, and Dave uses them himself.'),
              children: [
                for (final a in _alerts)
                  CupertinoListTile(
                    title: Text(a.label, maxLines: 2, style: const TextStyle(fontSize: 15)),
                    trailing: CupertinoSwitch(activeTrackColor: Look.of(context).accent, 
                      value: a.on,
                      onChanged: (v) async {
                        final api = AppScope.of(context).api;
                        final ok = await runAction(context, (_) async {
                          final updated = await api.updateSetting('alert:${a.id}', v);
                          if (mounted) setState(() => _alerts = updated.alerts);
                        });
                        if (!ok && mounted) setState(() {});
                      },
                    ),
                  ),
              ],
            ),
          ]),
        ),
      );
}

class _AiSection extends StatelessWidget {
  const _AiSection({required this.s, required this.providers, required this.reload});
  final AppSettings s;
  final ProviderList providers;
  final Future<void> Function() reload;

  @override
  Widget build(BuildContext context) {
    final primary = s.primaryTimeout.value.round();
    final fallback = s.fallbackTimeout.value.round();
    return CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
      header: const ListHeader('AI'),
      footer: const ListFooter('AI wait is how long Dave waits for an answer before switching to the next key or provider; backup wait is the same for the backup.'),
      children: [
        CupertinoListTile(
          leading: Icon(CupertinoIcons.bolt_fill, color: Look.of(context).accent),
          title: const Text('Main AI & model'),
          subtitle: Text(providers.main == null ? 'Tap to choose' : '${providers.main!.name} · ${providers.main!.model}', maxLines: 1, overflow: TextOverflow.ellipsis),
          trailing: Icon(CupertinoIcons.chevron_up_chevron_down, size: 16, color: resolve(context, CupertinoColors.secondaryLabel)),
          onTap: () async {
            if (await showAiSheet(context, providers)) await reload();
          },
        ),
        CupertinoListTile(
          key: const ValueKey('open-dave-voice'),
          leading: const Icon(CupertinoIcons.waveform),
          title: const Text("Dave's voice"),
          subtitle: const Text('ElevenLabs · Fish Audio'),
          trailing: const CupertinoListTileChevron(),
          onTap: () => pushScoped<void>(context, const DaveVoicePage()),
        ),
        CupertinoListTile(
          leading: const Icon(CupertinoIcons.sparkles),
          title: const Text('AI providers'),
          subtitle: Text(
            [
              providers.main == null ? 'No main AI' : 'Main: ${providers.main!.name}',
              if (providers.backups.isNotEmpty) '${providers.backups.length} backup${providers.backups.length == 1 ? '' : 's'}',
            ].join('  ·  '),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          trailing: const CupertinoListTileChevron(),
          onTap: () async {
            await pushScoped<void>(context, const ProvidersPage());
            await reload();
          },
        ),
        CupertinoListTile(
          leading: const Icon(CupertinoIcons.hourglass),
          title: const Text('AI wait'),
          trailing: _Stepper(
            text: '${primary}s',
            onMinus: primary - 5 < s.primaryTimeout.min ? null : () => _set(context, 'primaryTimeoutSeconds', primary - 5, reload),
            onPlus: primary + 5 > s.primaryTimeout.max ? null : () => _set(context, 'primaryTimeoutSeconds', primary + 5, reload),
            less: 'Shorter wait',
            more: 'Longer wait',
          ),
        ),
        CupertinoListTile(
          leading: const Icon(CupertinoIcons.arrow_2_squarepath),
          title: const Text('Backup wait'),
          trailing: _Stepper(
            text: '${fallback}s',
            onMinus: fallback - 1 < s.fallbackTimeout.min ? null : () => _set(context, 'fallbackTimeoutSeconds', fallback - 1, reload),
            onPlus: fallback + 1 > s.fallbackTimeout.max ? null : () => _set(context, 'fallbackTimeoutSeconds', fallback + 1, reload),
            less: 'Shorter backup wait',
            more: 'Longer backup wait',
          ),
        ),
      ],
    );
  }
}

/// − value + with 44pt targets.
class _Stepper extends StatelessWidget {
  const _Stepper({required this.text, required this.onMinus, required this.onPlus, required this.less, required this.more});
  final String text;
  final VoidCallback? onMinus;
  final VoidCallback? onPlus;
  final String less;
  final String more;

  @override
  Widget build(BuildContext context) => Row(mainAxisSize: MainAxisSize.min, children: [
        _StepButton(icon: CupertinoIcons.minus, label: less, onTap: onMinus),
        SizedBox(width: 52, child: Text(text, textAlign: TextAlign.center, style: const TextStyle(fontFeatures: [FontFeature.tabularFigures()]))),
        _StepButton(icon: CupertinoIcons.plus, label: more, onTap: onPlus),
      ]);
}

class _StepButton extends StatelessWidget {
  const _StepButton({required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        label: label,
        child: CupertinoButton(
          padding: EdgeInsets.zero,
          minimumSize: const Size(Space.tap, Space.tap),
          onPressed: onTap == null
              ? null
              : () {
                  HapticFeedback.selectionClick();
                  onTap!();
                },
          child: Icon(icon, size: 20),
        ),
      );
}

class _NotificationSection extends StatelessWidget {
  const _NotificationSection({required this.data, required this.reload});
  final _SettingsData data;
  final Future<void> Function() reload;

  Future<void> _toggle(BuildContext context, bool on) async {
    if (on) {
      final granted = await PushService.requestNotificationPermission();
      if (!granted) {
        if (context.mounted) {
          final where = defaultTargetPlatform == TargetPlatform.iOS ? 'iPhone Settings > Notifications' : 'Android settings';
          await showError(context, 'Notifications are turned off for Dave in $where. Turn them on there, then try again.');
        }
        return;
      }
      await Session.setNotificationsEnabled(true);
      await PushService.start();
    } else {
      await Session.setNotificationsEnabled(false);
      await PushService.stop();
    }
    await reload();
  }

  @override
  Widget build(BuildContext context) => CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
        header: const ListHeader('Phone notifications'),
        footer: ListFooter(defaultTargetPlatform == TargetPlatform.iOS
            ? 'Alerts come straight from your own server. On iPhone they arrive while Dave is open or recently used: iOS pauses the connection after a while in the background, and Dave catches up on anything missed the next time it runs.'
            : 'Alerts come straight from your own server -- no Firebase, nothing else to install. Android requires a small ongoing "Dave" notification while Dave stays connected. Some phones also need battery optimisation turned off for Dave, or they cut the connection to save power.'),
        children: [
          CupertinoListTile(
            leading: const Icon(CupertinoIcons.bell),
            title: const Text('Trade alerts'),
            subtitle: Text(data.notifications ? (data.serviceRunning ? 'Connected' : 'Starting…') : 'Off'),
            trailing: CupertinoSwitch(activeTrackColor: Look.of(context).accent, value: data.notifications, onChanged: (v) => _toggle(context, v)),
          ),
          if (defaultTargetPlatform == TargetPlatform.android)
            CupertinoListTile(
              leading: const Icon(CupertinoIcons.battery_25),
            title: const Text('Battery optimisation'),
            subtitle: Text(data.batteryExempt ? 'Off for Dave -- alerts stay reliable' : 'On -- your phone may cut the connection'),
            trailing: data.batteryExempt ? null : const CupertinoListTileChevron(),
            onTap: data.batteryExempt
                ? null
                : () async {
                    await PushService.requestIgnoreBatteryOptimization();
                    await reload();
                  },
          ),
        ],
      );
}

class _ConnectionSection extends StatefulWidget {
  const _ConnectionSection();

  @override
  State<_ConnectionSection> createState() => _ConnectionSectionState();
}

/// Every bot this phone is paired with (the trader's own, a friend's...), one tap to switch.
class _ConnectionSectionState extends State<_ConnectionSection> {
  List<SavedBot>? _bots;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    try {
      final bots = await Session.accounts();
      if (mounted) setState(() => _bots = bots);
    } catch (_) {
      if (mounted) setState(() => _bots = const []);
    }
  }

  Future<void> _rename(SavedBot b) async {
    final name = await promptText(context, title: 'Name this bot', message: b.endpoint.host, initial: b.name ?? '', placeholder: "e.g. Mine, Friend's");
    if (name == null) return;
    await Session.renameAccount(b.endpoint, name);
    await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final scope = AppScope.of(context);
    final look = Look.of(context);
    final current = scope.api.base.toString();
    final bots = _bots ?? const <SavedBot>[];
    return CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
      header: const ListHeader('Bots'),
      footer: const ListFooter('Tap a bot to switch to it. Long-press to name it. To remove this phone\'s access completely, disconnect it from the Phone App tab in the web panel as well.'),
      children: [
        if (bots.isEmpty)
          CupertinoListTile(
            leading: const Icon(CupertinoIcons.cloud),
            title: const Text('Server'),
            subtitle: Text(scope.api.base.host, overflow: TextOverflow.ellipsis),
          ),
        for (final b in bots)
          GestureDetector(
            onLongPress: () => _rename(b),
            child: CupertinoListTile(
              key: ValueKey('bot-${b.endpoint.host}'),
              leading: Icon(CupertinoIcons.cloud_fill, color: b.endpoint.toString() == current ? look.accent : resolve(context, CupertinoColors.systemGrey)),
              title: Text(b.label),
              subtitle: Text(b.endpoint.host, overflow: TextOverflow.ellipsis),
              trailing: b.endpoint.toString() == current ? Icon(CupertinoIcons.checkmark_alt, color: look.accent) : null,
              onTap: b.endpoint.toString() == current || scope.onSwitchBot == null ? null : () => scope.onSwitchBot!(b),
            ),
          ),
        if (scope.onSwitchBot != null)
          CupertinoListTile(
            leading: Icon(CupertinoIcons.plus_circle_fill, color: look.accent),
            title: Text('Pair another bot', style: TextStyle(color: look.accent)),
            onTap: () => scope.onSwitchBot!(null),
          ),
        CupertinoListTile(
          leading: Icon(CupertinoIcons.xmark_circle, color: look.down),
          title: Text('Disconnect from this bot', style: TextStyle(color: look.down)),
          onTap: () async {
            final ok = await confirmDestructive(context, title: 'Disconnect from this bot?', message: 'You will need a new pairing code from its web panel to connect again.', action: 'Disconnect');
            if (ok) scope.onUnpaired('Disconnected. Get a new pairing code from the web panel to connect again.');
          },
        ),
      ],
    );
  }
}

/// How hard "Deeper thinking" works: Low · Medium · High · Max, with what each one costs.
/// What Dave does when an alert on his trade calls for a decision: nothing, tell you, or act.
class _ReviewModeRow extends StatelessWidget {
  const _ReviewModeRow({required this.mode, required this.onPick});
  final String mode;
  final void Function(String) onPick;

  static const _about = {
    'off': 'Alerts only. Dave doesn\'t review the trade.',
    'advise': 'Dave reviews the trade and tells you what he\'d do. Nothing is touched.',
    'act': 'Dave does the protective ones himself: breakeven, a tighter stop, an exit rule, a partial. A full close only when he judges the idea broken. Never widens a stop.',
  };

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.s4, Space.s3, Space.s4, Space.s3),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Self-aware reviews', style: TextStyle(fontSize: 15, color: resolve(context, CupertinoColors.label))),
        const SizedBox(height: 8),
        Container(
          key: const ValueKey('self-aware-mode'),
          padding: const EdgeInsets.all(3),
          decoration: BoxDecoration(color: look.chip, borderRadius: BorderRadius.circular(12)),
          child: Row(children: [
            for (final m in const ['off', 'advise', 'act'])
              Expanded(
                child: GestureDetector(
                  onTap: () => onPick(m),
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 150),
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(color: m == mode ? look.accent : null, borderRadius: BorderRadius.circular(9)),
                    child: Text(m[0].toUpperCase() + m.substring(1), style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: m == mode ? look.tabActiveIcon : null)),
                  ),
                ),
              ),
          ]),
        ),
        const SizedBox(height: 6),
        Text(_about[mode] ?? '', style: TextStyle(fontSize: 12, color: resolve(context, CupertinoColors.secondaryLabel))),
      ]),
    );
  }
}

class _EffortRow extends StatelessWidget {
  const _EffortRow({required this.effort, required this.onPick});
  final String effort;
  final void Function(String) onPick;

  static const _about = {
    'low': 'Up to 4 steps. Quick check, always looking at the spike, sniper entry, scalp and the edge.',
    'medium': 'Up to 6 steps, with the spike, sniper entry, scalp and the edge in view.',
    'high': 'Up to 14 steps through a checklist: bias, spike, trigger, sniper entry, scalp, stop, target, the edge, the case against, your rules & past calls, verdict. Can\'t stop early.',
    'xhigh': 'Thinks at least 13 times, up to 16: every checklist step, the what-if path, then goes back over its own steps from fresh angles, then a sceptical critic. Slow, costs more.',
    'max': 'At least 14 steps, up to 18: everything X-High does, with the most room to think. Slowest, costs most.',
  };

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.s4, 4, Space.s4, Space.s3),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          key: const ValueKey('thinking-effort'),
          padding: const EdgeInsets.all(3),
          decoration: BoxDecoration(color: look.chip, borderRadius: BorderRadius.circular(12)),
          child: Row(children: [
            for (final e in const ['low', 'medium', 'high', 'xhigh', 'max'])
              Expanded(
                child: GestureDetector(
                  onTap: () => onPick(e),
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 150),
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(color: e == effort ? look.accent : null, borderRadius: BorderRadius.circular(9)),
                    child: Text(e == 'xhigh' ? 'X-High' : e[0].toUpperCase() + e.substring(1), maxLines: 1, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: e == effort ? look.tabActiveIcon : null)),
                  ),
                ),
              ),
          ]),
        ),
        const SizedBox(height: 6),
        Text(_about[effort] ?? '', style: TextStyle(fontSize: 12, color: resolve(context, CupertinoColors.secondaryLabel))),
      ]),
    );
  }
}
