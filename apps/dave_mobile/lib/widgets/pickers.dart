import 'dart:math' as math;
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
  // Not a bottom sheet sliding up (the trader: "it looks like iPhone when switching") -- a panel
  // that drops from the top of the screen, fading and growing into place, providers down a rail
  // on the left and the models as a plain list on the right.
  final scope = AppScope.of(context);
  final changed = await showGeneralDialog<bool>(
    context: context,
    barrierDismissible: true,
    barrierLabel: 'Close',
    barrierColor: const Color(0x99000000),
    transitionDuration: const Duration(milliseconds: 190),
    pageBuilder: (ctx, _, _) => AppScope(api: scope.api, onUnpaired: scope.onUnpaired, onSwitchBot: scope.onSwitchBot, child: _AiSheet(list: list)),
    transitionBuilder: (ctx, anim, _, child) {
      final curved = CurvedAnimation(parent: anim, curve: Curves.easeOutCubic);
      return FadeTransition(
        opacity: curved,
        child: ScaleTransition(alignment: Alignment.topCenter, scale: Tween(begin: 0.92, end: 1.0).animate(curved), child: child),
      );
    },
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
    // After the first frame: the API comes from an inherited widget, which initState can't read.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _selected != null) _load(_selected!);
    });
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
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final media = MediaQuery.of(context);
    return Align(
      alignment: Alignment.topCenter,
      child: Padding(
        padding: EdgeInsets.fromLTRB(12, media.padding.top + 8, 12, media.viewInsets.bottom + 12),
        child: Container(
          key: const ValueKey('ai-palette'),
          constraints: BoxConstraints(maxHeight: (media.size.height - media.padding.top - media.viewInsets.bottom) * 0.78, maxWidth: 560),
          decoration: BoxDecoration(
            color: look.card,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: look.accent.withValues(alpha: 0.45)),
            boxShadow: [BoxShadow(color: look.accent.withValues(alpha: 0.18), blurRadius: 30, spreadRadius: 1)],
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            // Header
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 8, 10),
              child: Row(children: [
                Container(
                  width: 34,
                  height: 34,
                  decoration: BoxDecoration(color: look.accent, borderRadius: BorderRadius.circular(10)),
                  child: Icon(CupertinoIcons.sparkles, size: 18, color: look.tabActiveIcon),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Text("Dave's brain", style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                    Text(widget.list.main == null ? 'No main AI yet' : '${widget.list.main!.name} · ${widget.list.main!.model}',
                        maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: secondary)),
                  ]),
                ),
                if (_busy) const Padding(padding: EdgeInsets.only(right: 8), child: CupertinoActivityIndicator()),
                CupertinoButton(padding: EdgeInsets.zero, minimumSize: const Size(36, 36), onPressed: () => Navigator.of(context).pop(false), child: Icon(CupertinoIcons.xmark, size: 18, color: secondary)),
              ]),
            ),
            Container(height: 1, color: look.line),
            if (_providers.isEmpty)
              Padding(padding: const EdgeInsets.all(16), child: Text('No provider has a key yet. Add one in Settings → AI & models → AI providers.', style: TextStyle(color: secondary)))
            else
              Flexible(
                child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  // Provider rail
                  Container(
                    width: 112,
                    color: look.chip.withValues(alpha: 0.5),
                    child: ListView(padding: const EdgeInsets.symmetric(vertical: 6), children: [
                      for (final x in _providers)
                        GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          onTap: () {
                            setState(() {
                              _selected = x;
                              _query = '';
                            });
                            _load(x);
                          },
                          child: AnimatedContainer(
                            duration: const Duration(milliseconds: 140),
                            margin: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            padding: const EdgeInsets.fromLTRB(10, 9, 6, 9),
                            decoration: BoxDecoration(
                              color: x.provider == p?.provider ? look.accent.withValues(alpha: 0.16) : null,
                              borderRadius: BorderRadius.circular(10),
                              border: Border(left: BorderSide(color: x.provider == p?.provider ? look.accent : const Color(0x00000000), width: 3)),
                            ),
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text(x.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, fontWeight: x.provider == p?.provider ? FontWeight.w800 : FontWeight.w600)),
                              if (x.isPrimary || x.isBackup)
                                Text(x.isPrimary ? 'MAIN' : 'BACKUP ${x.backupPosition}', style: TextStyle(fontSize: 9.5, fontWeight: FontWeight.w800, letterSpacing: 0.8, color: x.isPrimary ? look.accent : secondary)),
                            ]),
                          ),
                        ),
                    ]),
                  ),
                  Container(width: 1, color: look.line),
                  // Models
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(10, 10, 10, 6),
                        child: CupertinoTextField(
                          placeholder: models == null ? 'Loading models…' : 'Filter ${models.length} models',
                          prefix: Padding(padding: const EdgeInsets.only(left: 10), child: Icon(CupertinoIcons.line_horizontal_3_decrease, size: 16, color: secondary)),
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 9),
                          decoration: BoxDecoration(color: look.chip, borderRadius: BorderRadius.circular(10), border: Border.all(color: look.line)),
                          style: const TextStyle(fontSize: 14),
                          onChanged: (v) => setState(() => _query = v),
                        ),
                      ),
                      if (p != null && !p.isPrimary)
                        GestureDetector(
                          onTap: _busy ? null : () => _use(p, null),
                          child: Container(
                            margin: const EdgeInsets.fromLTRB(10, 0, 10, 6),
                            padding: const EdgeInsets.symmetric(vertical: 9, horizontal: 10),
                            decoration: BoxDecoration(color: look.accent, borderRadius: BorderRadius.circular(10)),
                            child: Text('Make ${p.name} main (${p.model.split('/').last})', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: look.tabActiveIcon, fontWeight: FontWeight.w700, fontSize: 13)),
                          ),
                        ),
                      Flexible(
                        child: p != null && _errors[p.provider] != null
                            ? Padding(padding: const EdgeInsets.all(10), child: Text(_errors[p.provider]!, style: TextStyle(color: look.down, fontSize: 13)))
                            : shown == null
                                ? const Padding(padding: EdgeInsets.all(20), child: CupertinoActivityIndicator())
                                : shown.isEmpty && (models?.isEmpty ?? true)
                                    ? Padding(padding: const EdgeInsets.all(10), child: Text('${p?.name} doesn\'t list its models -- type one below.', style: TextStyle(color: secondary, fontSize: 13)))
                                    : ListView.builder(
                                        shrinkWrap: true,
                                        padding: const EdgeInsets.only(bottom: 4),
                                        itemCount: math.min(shown.length, 200),
                                        itemBuilder: (context, i) {
                                          final m = shown[i];
                                          final current = m == p!.model;
                                          return GestureDetector(
                                            behavior: HitTestBehavior.opaque,
                                            onTap: _busy ? null : () => _use(p, m),
                                            child: Padding(
                                              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                                              child: Row(children: [
                                                Container(
                                                  width: 8,
                                                  height: 8,
                                                  decoration: BoxDecoration(shape: BoxShape.circle, color: current ? look.accent : look.line),
                                                ),
                                                const SizedBox(width: 10),
                                                Expanded(
                                                  child: Text(m,
                                                      maxLines: 1,
                                                      overflow: TextOverflow.ellipsis,
                                                      style: TextStyle(fontSize: 13.5, fontWeight: current ? FontWeight.w800 : FontWeight.w500, color: current ? look.accent : null)),
                                                ),
                                                if (current) Text('IN USE', style: TextStyle(fontSize: 9.5, fontWeight: FontWeight.w800, letterSpacing: 0.8, color: look.accent)),
                                              ]),
                                            ),
                                          );
                                        },
                                      ),
                      ),
                      if (p != null)
                        GestureDetector(
                          onTap: _busy
                              ? null
                              : () async {
                                  final typed = await promptText(context, title: 'Model id', message: 'Exactly as ${p.name} names it.', initial: p.model);
                                  if (typed != null && typed.trim().isNotEmpty && mounted) await _use(p, typed.trim());
                                },
                          child: Padding(
                            padding: const EdgeInsets.fromLTRB(12, 6, 12, 12),
                            child: Row(children: [
                              Icon(CupertinoIcons.keyboard, size: 15, color: look.accent),
                              const SizedBox(width: 6),
                              Text('Type a model id', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: look.accent)),
                            ]),
                          ),
                        ),
                    ]),
                  ),
                ]),
              ),
          ]),
        ),
      ),
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
  const _Sheet({required this.title, required this.children});
  final String title;
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
            ]),
            const SizedBox(height: 12),
            ...children,
          ]),
        ),
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
