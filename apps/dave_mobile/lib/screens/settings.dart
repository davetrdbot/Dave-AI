import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../app_scope.dart';
import '../push/push_service.dart';
import '../session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'context.dart';
import 'mt5.dart';
import 'providers.dart';

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
      load: (api) async {
        final results = await Future.wait([api.bot(), api.settings(), api.providers()]);
        return _SettingsData(
          results[0] as BotState,
          results[1] as AppSettings,
          results[2] as ProviderList,
          await Session.notificationsEnabled(),
          await PushService.isRunning,
          await PushService.isIgnoringBatteryOptimizations,
        );
      },
      builder: (context, data, reload) => [
        SliverToBoxAdapter(child: _TradingSection(bot: data.bot, reload: reload)),
        SliverToBoxAdapter(child: _RiskSection(s: data.settings, reload: reload)),
        SliverToBoxAdapter(child: _MarketsSection(s: data.settings, reload: reload)),
        SliverToBoxAdapter(child: _BehaviourSection(s: data.settings, reload: reload)),
        SliverToBoxAdapter(child: _AlertsSection(s: data.settings, reload: reload)),
        SliverToBoxAdapter(child: _AiSection(s: data.settings, providers: data.providers, reload: reload)),
        SliverToBoxAdapter(child: _NotificationSection(data: data, reload: reload)),
        const SliverToBoxAdapter(child: _ConnectionSection()),
      ],
    );
  }
}

Future<void> _guarded(BuildContext context, Future<void> Function(DaveApi api) action, Future<void> Function() reload) async {
  if (await runAction(context, action)) await reload();
}

/// Changes one server-side setting, then reloads so the screen shows what was actually stored.
Future<void> _set(BuildContext context, String id, Object? value, Future<void> Function() reload) =>
    _guarded(context, (api) => api.updateSetting(id, value), reload);

String _num(double v) => v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(1);

// ---------------------------------------------------------------------------------------------

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
            trailing: CupertinoSwitch(
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
            trailing: CupertinoSwitch(value: bot.executionEnabled, onChanged: (v) => _guarded(context, (api) => api.updateBot(executionEnabled: v), reload)),
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
      footer: const ListFooter('Dave skips any setup whose reward is smaller than this multiple of its risk. Below the confidence level he asks you first, unless auto-approve is on.'),
      children: [
        CupertinoListTile(
          leading: const Icon(CupertinoIcons.arrow_up_right_circle),
          title: const Text('Min reward'),
          trailing: _Stepper(
            text: '1:${_num(rr)}',
            onMinus: rr - 0.5 < s.riskReward.min ? null : () => _set(context, 'riskReward', rr - 0.5, reload),
            onPlus: rr + 0.5 > s.riskReward.max ? null : () => _set(context, 'riskReward', rr + 0.5, reload),
            less: 'Lower minimum reward',
            more: 'Raise minimum reward',
          ),
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
          trailing: CupertinoSwitch(value: s.autoApproveBelowThreshold, onChanged: (v) => _set(context, 'autoApproveBelowThreshold', v, reload)),
        ),
        _riskModeTile(context, 'stopLoss', 'Stop loss', CupertinoIcons.shield, s.stopLoss),
        _riskModeTile(context, 'takeProfit', 'Take profit', CupertinoIcons.flag, s.takeProfit),
        _riskModeTile(context, 'lotSize', 'Lot size', CupertinoIcons.cube_box, s.lotSize),
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

  Widget _riskModeTile(BuildContext context, String id, String title, IconData icon, RiskMode mode) => CupertinoListTile(
        leading: Icon(icon),
        title: Text(title),
        additionalInfo: Text(mode.summary),
        trailing: const CupertinoListTileChevron(),
        onTap: () async {
          final changed = await pushScoped<bool>(context, _RiskModePage(id: id, title: title, mode: mode));
          if (changed == true) await reload();
        },
      );
}

/// Off / fixed value / Dave decides, for stop loss, take profit or lot size.
class _RiskModePage extends StatefulWidget {
  const _RiskModePage({required this.id, required this.title, required this.mode});
  final String id;
  final String title;
  final RiskMode mode;

  @override
  State<_RiskModePage> createState() => _RiskModePageState();
}

class _RiskModePageState extends State<_RiskModePage> {
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
            Text(_error!, style: TextStyle(fontSize: 14, color: resolve(context, CupertinoColors.systemRed))),
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
                    trailing: o.$1 == current ? Icon(CupertinoIcons.checkmark_alt, color: resolve(context, CupertinoColors.systemBlue)) : null,
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
        trailing: CupertinoSwitch(value: value, onChanged: (v) => _set(context, id, v, reload)),
      );

  @override
  Widget build(BuildContext context) => CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
        header: const ListHeader('How Dave works'),
        children: [
          _toggle(context, 'selfPause', CupertinoIcons.pause_circle, 'Self-pause', 'Dave may pause himself in bad conditions', s.selfPause),
          _toggle(context, 'twoStepTrading', CupertinoIcons.person_2, 'Two-step trading', 'A second AI reviews every trade first', s.twoStepTrading),
          _toggle(context, 'sequentialThinking', CupertinoIcons.list_number, 'Deeper thinking', 'Step-by-step trade decisions; slower, costs more', s.sequentialThinking),
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
    final deep = s.deepLossPercent.value.round();
    final on = s.alerts.where((a) => a.on).length;
    return CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
      header: const ListHeader('Trade alerts in Telegram'),
      footer: const ListFooter('Deep-loss is how far a losing trade gets toward its stop before Dave warns you.'),
      children: [
        CupertinoListTile(
          leading: const Icon(CupertinoIcons.exclamationmark_triangle),
          title: const Text('Deep-loss'),
          trailing: _Stepper(
            text: '$deep%',
            onMinus: deep - 5 < s.deepLossPercent.min ? null : () => _set(context, 'deepLossPercent', deep - 5, reload),
            onPlus: deep + 5 > s.deepLossPercent.max ? null : () => _set(context, 'deepLossPercent', deep + 5, reload),
            less: 'Warn earlier',
            more: 'Warn later',
          ),
        ),
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
                    trailing: CupertinoSwitch(
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
          leading: const Icon(CupertinoIcons.desktopcomputer),
          title: const Text('MetaTrader 5'),
          subtitle: const Text('Run MT5 in Dave\'s container -- no VPS'),
          trailing: const CupertinoListTileChevron(),
          onTap: () => pushScoped<void>(context, const Mt5Page()),
        ),
        CupertinoListTile(
          leading: const Icon(CupertinoIcons.gauge),
          title: const Text('Context & usage'),
          subtitle: const Text('How full Dave\'s context is, and today\'s AI use'),
          trailing: const CupertinoListTileChevron(),
          onTap: () => pushScoped<void>(context, const ContextScreen()),
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
            trailing: CupertinoSwitch(value: data.notifications, onChanged: (v) => _toggle(context, v)),
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

class _ConnectionSection extends StatelessWidget {
  const _ConnectionSection();

  @override
  Widget build(BuildContext context) {
    final scope = AppScope.of(context);
    return CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
      header: const ListHeader('Connection'),
      footer: const ListFooter('To remove this phone\'s access completely, disconnect it from the Phone App tab in the web panel as well.'),
      children: [
        CupertinoListTile(
          leading: const Icon(CupertinoIcons.cloud),
          title: const Text('Server'),
          // A subtitle, not trailing info: Railway hosts are long and the trailing slot cannot shrink.
          subtitle: Text(scope.api.base.host, overflow: TextOverflow.ellipsis),
        ),
        CupertinoListTile(
          leading: Icon(CupertinoIcons.xmark_circle, color: resolve(context, CupertinoColors.systemRed)),
          title: Text('Disconnect this phone', style: TextStyle(color: resolve(context, CupertinoColors.systemRed))),
          onTap: () async {
            final ok = await confirmDestructive(context, title: 'Disconnect this phone?', message: 'You will need a new pairing code from the web panel to connect again.', action: 'Disconnect');
            if (ok) scope.onUnpaired('Disconnected. Get a new pairing code from the web panel to connect again.');
          },
        ),
      ],
    );
  }
}
