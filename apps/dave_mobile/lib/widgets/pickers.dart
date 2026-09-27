import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../api/models.dart';
import '../app_scope.dart';
import '../look.dart';
import '../theme.dart';
import 'common.dart';

/// Inline controls instead of "tap, go to the next page, choose, come back" -- the trader: "it
/// should just give me a tool to configure it instead of next".

// ---------------------------------------------------------------------------------------------
// AI + model: one sheet. Providers with keys along the top, that provider's models as a
// searchable grid of chips underneath. Tapping a model makes that provider Dave's main AI with it.

/// Returns true when something changed.
Future<bool> showAiSheet(BuildContext context, ProviderList list) async {
  final changed = await showCupertinoModalPopup<bool>(
    context: context,
    builder: (ctx) => AppScope(api: AppScope.of(context).api, onUnpaired: AppScope.of(context).onUnpaired, child: _AiSheet(list: list)),
  );
  return changed == true;
}

class _AiSheet extends StatefulWidget {
  const _AiSheet({required this.list});
  final ProviderList list;

  @override
  State<_AiSheet> createState() => _AiSheetState();
}

class _AiSheetState extends State<_AiSheet> {
  late final List<ProviderSummary> _providers = [
    if (widget.list.main != null) widget.list.main!,
    ...widget.list.backups,
    ...widget.list.withKeys,
  ];
  late ProviderSummary? _selected = _providers.isEmpty ? null : _providers.first;
  final Map<String, List<String>> _models = {};
  final Map<String, String> _errors = {};
  String _query = '';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    if (_selected != null) _load(_selected!);
  }

  Future<void> _load(ProviderSummary p) async {
    if (_models.containsKey(p.provider)) return;
    try {
      final m = await AppScope.of(context).api.providerModels(p.provider);
      if (mounted) setState(() => _models[p.provider] = m..sort());
    } catch (e) {
      if (mounted) setState(() => _errors[p.provider] = '$e');
    }
  }

  Future<void> _use(ProviderSummary p, String? model) async {
    setState(() => _busy = true);
    final ok = await runAction(context, (api) async {
      if (model != null && model != p.model) await api.providerAction(p.provider, 'set-model', {'model': model});
      if (!p.isPrimary) await api.providerAction(p.provider, 'make-main');
    });
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final p = _selected;
    final models = p == null ? null : _models[p.provider];
    final shown = models?.where((m) => m.toLowerCase().contains(_query.toLowerCase())).toList();
    return _Sheet(
      title: 'Dave\'s AI',
      subtitle: widget.list.main == null ? 'No main AI yet' : 'Now: ${widget.list.main!.name} · ${widget.list.main!.model}',
      busy: _busy,
      children: [
        if (_providers.isEmpty)
          Text('No provider has a key yet. Add one in Settings → AI & models → AI providers.', style: TextStyle(color: resolve(context, CupertinoColors.secondaryLabel)))
        else ...[
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(children: [
              for (final x in _providers) ...[
                _Pill(
                  label: x.name,
                  badge: x.isPrimary ? 'main' : (x.isBackup ? 'backup ${x.backupPosition}' : null),
                  selected: x.provider == p?.provider,
                  onTap: () {
                    setState(() {
                      _selected = x;
                      _query = '';
                    });
                    _load(x);
                  },
                ),
                const SizedBox(width: 6),
              ],
            ]),
          ),
          const SizedBox(height: 12),
          if (p != null && !p.isPrimary)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: CupertinoButton(
                color: look.accent,
                padding: const EdgeInsets.symmetric(vertical: 10),
                borderRadius: BorderRadius.circular(12),
                onPressed: _busy ? null : () => _use(p, null),
                child: Text('Use ${p.name} (${p.model})', style: TextStyle(color: look.tabActiveIcon, fontWeight: FontWeight.w600, fontSize: 15)),
              ),
            ),
          CupertinoSearchTextField(placeholder: models == null ? 'Loading models…' : 'Search ${models.length} models', onChanged: (v) => setState(() => _query = v)),
          const SizedBox(height: 10),
          if (p != null && _errors[p.provider] != null)
            Text(_errors[p.provider]!, style: TextStyle(color: look.down, fontSize: 13))
          else if (shown == null)
            const Padding(padding: EdgeInsets.all(20), child: CupertinoActivityIndicator())
          else if (shown.isEmpty && (models?.isEmpty ?? true))
            Text('${p?.name} doesn\'t list its models -- type one below.', style: TextStyle(color: resolve(context, CupertinoColors.secondaryLabel), fontSize: 13))
          else
            Wrap(spacing: 6, runSpacing: 6, children: [
              for (final m in shown.take(120))
                _Pill(label: m, selected: m == p!.model, dense: true, onTap: _busy ? null : () => _use(p, m)),
            ]),
          const SizedBox(height: 10),
          if (p != null)
            CupertinoButton(
              padding: EdgeInsets.zero,
              onPressed: _busy
                  ? null
                  : () async {
                      final typed = await promptText(context, title: 'Model id', message: 'Exactly as ${p.name} names it.', initial: p.model);
                      if (typed != null && typed.trim().isNotEmpty && mounted) await _use(p, typed.trim());
                    },
              child: const Text('Type a model id'),
            ),
        ],
      ],
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Stop loss / take profit / lot size: Off · Fixed · Dave decides, with the number right there.

class RiskModeCard extends StatefulWidget {
  const RiskModeCard({super.key, required this.id, required this.title, required this.icon, required this.mode, required this.onChanged});
  final String id;
  final String title;
  final IconData icon;
  final RiskMode mode;
  final Future<void> Function() onChanged;

  @override
  State<RiskModeCard> createState() => _RiskModeCardState();
}

class _RiskModeCardState extends State<RiskModeCard> {
  late String _mode = widget.mode.mode;
  late final _value = TextEditingController(text: _fmt(widget.mode.value));
  bool _busy = false;
  String? _error;

  static String _fmt(double? v) => v == null ? '' : (v == v.roundToDouble() ? v.toStringAsFixed(0) : '$v');

  @override
  void didUpdateWidget(RiskModeCard old) {
    super.didUpdateWidget(old);
    if (old.mode.mode != widget.mode.mode || old.mode.value != widget.mode.value) {
      _mode = widget.mode.mode;
      _value.text = _fmt(widget.mode.value);
    }
  }

  @override
  void dispose() {
    _value.dispose();
    super.dispose();
  }

  bool get _lots => widget.id == 'lotSize';
  String get _unit => widget.mode.unit.isEmpty ? (_lots ? 'lots' : 'pips') : widget.mode.unit;
  double get _step => _lots ? 0.01 : 5;

  Future<void> _save(String mode) async {
    double? v;
    if (mode == 'on') {
      v = double.tryParse(_value.text.trim().replaceAll(',', '.'));
      if (v == null || v <= 0) {
        setState(() => _error = 'Enter a number above zero.');
        return;
      }
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final ok = await runAction(context, (api) => api.updateSetting(widget.id, {'mode': mode, 'value': ?v}));
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) {
      HapticFeedback.selectionClick();
      await widget.onChanged();
    }
  }

  void _nudge(int dir) {
    final now = double.tryParse(_value.text.trim()) ?? 0;
    final next = (now + dir * _step).clamp(_step, _lots ? 100.0 : 100000.0);
    _value.text = _lots ? next.toStringAsFixed(2) : _fmt(next);
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final saved = widget.mode;
    final dirty = _mode != saved.mode || (_mode == 'on' && _value.text.trim() != _fmt(saved.value));
    final explain = switch (_mode) {
      'on' => 'Every trade uses exactly this.',
      'auto' => 'Dave sets it for each trade from his analysis.',
      _ => 'No rule -- Dave uses his judgement.',
    };
    return Container(
      margin: const EdgeInsets.fromLTRB(Space.s4, 6, Space.s4, 6),
      padding: const EdgeInsets.all(14),
      decoration: glassDecoration(context, radius: 16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(widget.icon, size: 18, color: look.accent),
          const SizedBox(width: 8),
          Expanded(child: Text(widget.title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600))),
          if (_busy) const CupertinoActivityIndicator(radius: 8),
        ]),
        const SizedBox(height: 10),
        SizedBox(
          width: double.infinity,
          child: CupertinoSlidingSegmentedControl<String>(
            groupValue: _mode,
            children: const {
              'off': Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('Off', style: TextStyle(fontSize: 13))),
              'on': Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('Fixed', style: TextStyle(fontSize: 13))),
              'auto': Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('Dave decides', style: TextStyle(fontSize: 13))),
            },
            onValueChanged: (v) {
              if (v == null || _busy) return;
              setState(() => _mode = v);
              // Off and Dave-decides need nothing else: save straight away.
              if (v != 'on') _save(v);
            },
          ),
        ),
        const SizedBox(height: 8),
        Text(explain, style: TextStyle(fontSize: 12.5, color: resolve(context, CupertinoColors.secondaryLabel))),
        if (_mode == 'on') ...[
          const SizedBox(height: 10),
          Row(children: [
            _Round(icon: CupertinoIcons.minus, onTap: () => _nudge(-1)),
            const SizedBox(width: 8),
            Expanded(
              child: CupertinoTextField(
                controller: _value,
                textAlign: TextAlign.center,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                placeholder: _lots ? '0.01' : '30',
                onChanged: (_) => setState(() {}),
                onSubmitted: (_) => _save('on'),
                suffix: Padding(padding: const EdgeInsets.only(right: 10), child: Text(_unit, style: TextStyle(color: resolve(context, CupertinoColors.secondaryLabel)))),
                padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
                style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
                decoration: BoxDecoration(color: look.chip, borderRadius: BorderRadius.circular(10)),
              ),
            ),
            const SizedBox(width: 8),
            _Round(icon: CupertinoIcons.plus, onTap: () => _nudge(1)),
            const SizedBox(width: 8),
            CupertinoButton(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              minimumSize: const Size(0, 38),
              color: dirty ? look.accent : look.chip,
              borderRadius: BorderRadius.circular(10),
              onPressed: _busy || !dirty ? null : () => _save('on'),
              child: Text('Set', style: TextStyle(fontWeight: FontWeight.w700, color: dirty ? look.tabActiveIcon : resolve(context, CupertinoColors.secondaryLabel))),
            ),
          ]),
        ],
        if (_error != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_error!, style: TextStyle(color: look.down, fontSize: 13))),
      ]),
    );
  }
}

/// The same card as a popup, for the chat's SL / TP chips.
Future<bool> showRiskModeSheet(BuildContext context, {required String id, required String title, required IconData icon, required RiskMode mode}) async {
  var changed = false;
  await showCupertinoModalPopup<void>(
    context: context,
    builder: (ctx) => AppScope(
      api: AppScope.of(context).api,
      onUnpaired: AppScope.of(context).onUnpaired,
      child: _Sheet(title: title, children: [
        RiskModeCard(id: id, title: title, icon: icon, mode: mode, onChanged: () async {
          changed = true;
          if (ctx.mounted) Navigator.of(ctx).pop();
        }),
      ]),
    ),
  );
  return changed;
}

// ---------------------------------------------------------------------------------------------

class _Sheet extends StatelessWidget {
  const _Sheet({required this.title, this.subtitle, this.busy = false, required this.children});
  final String title;
  final String? subtitle;
  final bool busy;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Container(
      constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.82),
      decoration: BoxDecoration(color: look.card, borderRadius: const BorderRadius.vertical(top: Radius.circular(22))),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
          child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(16, 10, 16, 16), children: [
            Center(child: Container(width: 36, height: 4, decoration: BoxDecoration(color: look.line, borderRadius: BorderRadius.circular(2)))),
            const SizedBox(height: 12),
            Row(children: [
              Expanded(child: Text(title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700))),
              if (busy) const CupertinoActivityIndicator(),
            ]),
            if (subtitle != null) Padding(padding: const EdgeInsets.only(top: 2), child: Text(subtitle!, style: TextStyle(fontSize: 13, color: resolve(context, CupertinoColors.secondaryLabel)))),
            const SizedBox(height: 12),
            ...children,
          ]),
        ),
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.label, required this.selected, required this.onTap, this.badge, this.dense = false});
  final String label;
  final String? badge;
  final bool selected;
  final bool dense;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        padding: EdgeInsets.symmetric(horizontal: dense ? 10 : 14, vertical: dense ? 7 : 9),
        decoration: BoxDecoration(
          color: selected ? look.accent : look.chip,
          borderRadius: BorderRadius.circular(dense ? 10 : 14),
          border: Border.all(color: selected ? look.accent : look.line),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Flexible(
            child: Text(label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: dense ? 12.5 : 14, fontWeight: FontWeight.w600, color: selected ? look.tabActiveIcon : resolve(context, CupertinoColors.label))),
          ),
          if (badge != null) ...[
            const SizedBox(width: 6),
            Text(badge!, style: TextStyle(fontSize: 11, color: selected ? look.tabActiveIcon.withValues(alpha: 0.7) : resolve(context, CupertinoColors.secondaryLabel))),
          ],
        ]),
      ),
    );
  }
}

class _Round extends StatelessWidget {
  const _Round({required this.icon, required this.onTap});
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onTap,
        child: Container(
          width: 38,
          height: 38,
          decoration: BoxDecoration(color: Look.of(context).chip, borderRadius: BorderRadius.circular(10)),
          child: Icon(icon, size: 16),
        ),
      );
}
