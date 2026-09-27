import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../api/models.dart';
import '../app_scope.dart';
import '../look.dart';
import '../theme.dart';
import '../widgets/common.dart';

Widget _section(BuildContext context, {required String header, String? footer, required List<Widget> children}) => CupertinoListSection.insetGrouped(
      backgroundColor: const Color(0x00000000),
      decoration: glassDecoration(context, radius: 14),
      separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4),
      header: ListHeader(header),
      footer: footer == null ? null : ListFooter(footer),
      children: children,
    );

List<Map<String, dynamic>> _list(Object? v) => v is List ? v.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList() : const [];

String _when(Object? ms) {
  if (ms is! num) return '';
  final at = DateTime.fromMillisecondsSinceEpoch(ms.toInt());
  final d = at.difference(DateTime.now());
  if (d.isNegative) return formatAgo(at);
  if (d.inMinutes < 60) return 'in ${d.inMinutes} min';
  if (d.inHours < 48) return 'in ${d.inHours} h';
  return 'in ${d.inDays} days';
}

// ---------------------------------------------------------------------------------------------

/// Everything Dave has set himself and is waiting on: setups, reminders, marked price levels and
/// background checks -- each one can be cancelled from here.
class WatchlistPage extends StatelessWidget {
  const WatchlistPage({super.key});

  @override
  Widget build(BuildContext context) => LoadedPage<Map<String, dynamic>>(
        title: 'Waiting on',
        load: (api) => api.watchlist(),
        builder: (context, d, reload) {
          Future<void> cancel(String action, String id, String what) async {
            final ok = await confirmDestructive(context, title: 'Cancel this $what?', message: 'Dave stops waiting on it.', action: 'Cancel it');
            if (ok && context.mounted && await runAction(context, (api) => api.watchlistAction(action, id))) await reload();
          }

          Widget x(String action, String id, String what) => CupertinoButton(
                padding: EdgeInsets.zero,
                minimumSize: const Size(32, 32),
                onPressed: () => cancel(action, id, what),
                child: Icon(CupertinoIcons.xmark_circle_fill, color: Look.of(context).down, size: 22),
              );

          final setups = _list(d['setups']);
          final reminders = _list(d['reminders']);
          final levels = _list(d['levels']);
          final checks = _list(d['checks']);
          final empty = CupertinoListTile(title: Text('Nothing', style: TextStyle(color: resolve(context, CupertinoColors.secondaryLabel))));
          return [
            SliverToBoxAdapter(
              child: _section(context,
                  header: 'Setups',
                  footer: 'Trade plans that wait for price to do something first -- "above X, then back below Y, buy". Ask Dave in chat to write one.',
                  children: setups.isEmpty
                      ? [empty]
                      : [
                          for (final s in setups)
                            CupertinoListTile(
                              leading: Icon(
                                s['status'] == 'active'
                                    ? CupertinoIcons.hourglass
                                    : s['status'] == 'placed'
                                        ? CupertinoIcons.checkmark_seal_fill
                                        : CupertinoIcons.minus_circle,
                                color: s['status'] == 'placed' ? Look.of(context).up : null,
                              ),
                              title: Text('${s['plan']}', maxLines: 3),
                              subtitle: Text(
                                s['status'] == 'active' ? 'Step ${s['stage']}/${s['steps']} · ends ${_when(s['expiresAt'])} · ${s['reason']}' : '${s['status']} · ${s['outcome'] ?? ''}',
                                maxLines: 3,
                              ),
                              trailing: s['status'] == 'active' ? x('cancel-setup', '${s['id']}', 'setup') : null,
                            ),
                        ]),
            ),
            SliverToBoxAdapter(
              child: _section(context,
                  header: 'Reminders',
                  children: reminders.isEmpty
                      ? [empty]
                      : [
                          for (final r in reminders)
                            CupertinoListTile(
                              leading: const Icon(CupertinoIcons.bell),
                              title: Text('${r['text']}', maxLines: 3),
                              subtitle: Text([_when(r['dueAt']), if (r['symbol'] != null) '${r['symbol']}', if (r['reason'] != null) '${r['reason']}'].join(' · '), maxLines: 2),
                              trailing: x('cancel-reminder', '${r['id']}', 'reminder'),
                            ),
                        ]),
            ),
            SliverToBoxAdapter(
              child: _section(context,
                  header: 'Marked levels',
                  children: levels.isEmpty
                      ? [empty]
                      : [
                          for (final l in levels)
                            CupertinoListTile(
                              leading: Icon(l['kind'] == 'price_at_or_above' ? CupertinoIcons.arrow_up_to_line : CupertinoIcons.arrow_down_to_line),
                              title: Text('${l['symbol']} ${l['kind'] == 'price_at_or_above' ? '≥' : '≤'} ${l['level']}'),
                              subtitle: Text('${l['reason']}', maxLines: 3),
                              trailing: x('cancel-level', '${l['id']}', 'level'),
                            ),
                        ]),
            ),
            SliverToBoxAdapter(
              child: _section(context,
                  header: 'Background checks',
                  children: checks.isEmpty
                      ? [empty]
                      : [
                          for (final c in checks)
                            CupertinoListTile(
                              leading: const Icon(CupertinoIcons.eye),
                              title: Text('${c['whatToCheck'] ?? c['reason']}', maxLines: 3),
                              subtitle: Text('${c['checkCount'] ?? 0} checks · ends ${_when(c['expiresAt'])}', maxLines: 2),
                              trailing: x('stop-check', '${c['id']}', 'check'),
                            ),
                        ]),
            ),
          ];
        },
      );
}

// ---------------------------------------------------------------------------------------------

/// Dave's system prompt, part by part -- readable and editable from the phone. An edited part
/// is used from the next message on; Reset goes back to the original.
class PromptPage extends StatelessWidget {
  const PromptPage({super.key});

  @override
  Widget build(BuildContext context) => LoadedPage<Map<String, dynamic>>(
        title: 'Dave\'s prompt',
        load: (api) => api.promptParts(),
        builder: (context, d, reload) {
          final parts = _list(d['parts']);
          return [
            SliverToBoxAdapter(
              child: _section(context,
                  header: 'Parts',
                  footer: 'This is exactly what Dave reads before every message. Your edits apply from the next message, in Telegram and here. Reset puts a part back to the original.',
                  children: [
                    for (final p in parts)
                      CupertinoListTile(
                        leading: Icon(p['custom'] == true ? CupertinoIcons.pencil_circle_fill : CupertinoIcons.doc_text, color: p['custom'] == true ? Look.of(context).accent : null),
                        title: Text('${p['title']}'),
                        subtitle: Text(p['custom'] == true ? 'Edited · ${p['about']}' : '${p['about']}', maxLines: 2),
                        additionalInfo: Text('${((p['text'] as String?)?.length ?? 0) ~/ 1000}k'),
                        trailing: const CupertinoListTileChevron(),
                        onTap: () async {
                          final saved = await pushScoped<bool>(
                            context,
                            EditorPage(
                              title: '${p['title']}',
                              fields: [EditorField(label: '${p['file']}', initial: '${p['text']}', multiline: true, monospace: true)],
                              footer: 'Markdown. Saved on the server; Dave uses it from the next message.',
                              onSave: (v) async {
                                await AppScope.of(context).api.savePrompt('${p['file']}', v[0]);
                              },
                            ),
                          );
                          if (saved == true) await reload();
                        },
                      ),
                  ]),
            ),
            if (parts.any((p) => p['custom'] == true))
              SliverToBoxAdapter(
                child: _section(context, header: 'Reset', children: [
                  for (final p in parts.where((p) => p['custom'] == true))
                    CupertinoListTile(
                      leading: Icon(CupertinoIcons.arrow_counterclockwise, color: Look.of(context).down),
                      title: Text('Reset ${p['title']}', style: TextStyle(color: Look.of(context).down)),
                      onTap: () async {
                        final ok = await confirmDestructive(context, title: 'Reset ${p['title']}?', message: 'Your edits to this part are thrown away.', action: 'Reset');
                        if (ok && context.mounted && await runAction(context, (api) => api.resetPrompt('${p['file']}'))) await reload();
                      },
                    ),
                ]),
              ),
          ];
        },
      );
}

// ---------------------------------------------------------------------------------------------

class _Input {
  const _Input(this.key, this.title, this.about, {this.min = 0, this.max = 1 << 30, this.decimal = false, this.flag = false});
  final String key;
  final String title;
  final String about;
  final num min;
  final num max;
  final bool decimal;
  final bool flag;
}

const _inputs = [
  _Input('PushSeconds', 'Report every (s)', 'How often the EA sends Dave the account, positions and prices.', min: 2, max: 120),
  _Input('SlippagePoints', 'Slippage (points)', 'How far from the asked price a market order may fill.', min: 0, max: 1000),
  _Input('MagicNumber', 'Magic number', 'Tags Dave\'s orders in MT5 so they\'re told apart from yours.', min: 1, max: 2147483647),
  _Input('SwingLookback', 'Swing lookback (bars)', 'Bars the EA looks back to find swing highs and lows.', min: 2, max: 500),
  _Input('ZoneMax', 'Max zones', 'Most supply/demand zones reported per symbol.', min: 1, max: 50),
  _Input('EqTolerancePips', 'Equal highs/lows tolerance (pips)', 'How close two highs or lows must be to count as equal.', min: 0, max: 100, decimal: true),
  _Input('EnablePush', 'MT5 phone push', 'Also send alerts to the MT5 app on your phone.', flag: true),
  _Input('EnableEmail', 'MT5 email', 'Also send alerts by MT5\'s email settings.', flag: true),
];

/// The EA's inputs, changed from here instead of opening MT5. Saving recompiles the EA on its chart,
/// so the change takes a minute to land.
class EaSettingsPage extends StatelessWidget {
  const EaSettingsPage({super.key});

  @override
  Widget build(BuildContext context) => LoadedPage<Mt5View>(
        title: 'EA settings',
        load: (api) => api.mt5(),
        builder: (context, v, reload) {
          Future<void> save(String key, Object value) async {
            if (await runAction(context, (api) => api.mt5Action('settings', {
                  'inputs': {key: value}
                }))) {
              HapticFeedback.lightImpact();
              await reload();
            }
          }

          if (!v.hasAgent) {
            return [
              SliverToBoxAdapter(child: _section(context, header: 'Not set up', children: const [CupertinoListTile(title: Text('The MT5 service isn\'t running next to Dave yet.'))])),
            ];
          }
          return [
            SliverToBoxAdapter(
              child: _section(context,
                  header: 'DaveEA',
                  footer: 'Saving restarts MT5 on the same login with the new value -- give it a minute or two. Open trades stay open at the broker.',
                  children: [
                    for (final i in _inputs)
                      if (i.flag)
                        CupertinoListTile(
                          title: Text(i.title),
                          subtitle: Text(i.about, maxLines: 2),
                          trailing: CupertinoSwitch(
                            activeTrackColor: Look.of(context).accent,
                            value: (v.inputs[i.key] ?? 'true').toLowerCase() == 'true',
                            onChanged: (b) => save(i.key, b),
                          ),
                        )
                      else
                        CupertinoListTile(
                          title: Text(i.title),
                          subtitle: Text(i.about, maxLines: 2),
                          additionalInfo: Text(v.inputs[i.key] ?? '—'),
                          trailing: const CupertinoListTileChevron(),
                          onTap: () async {
                            final s = await promptText(context,
                                title: i.title,
                                message: '${i.about}\n${i.min} to ${i.max}.',
                                initial: v.inputs[i.key] ?? '',
                                keyboardType: TextInputType.numberWithOptions(decimal: i.decimal));
                            if (s == null || !context.mounted) return;
                            final n = i.decimal ? double.tryParse(s.trim()) : int.tryParse(s.trim());
                            if (n == null || n < i.min || n > i.max) return showError(context, 'Use a ${i.decimal ? '' : 'whole '}number from ${i.min} to ${i.max}.');
                            if ('$n' != v.inputs[i.key]) await save(i.key, n);
                          },
                        ),
                  ]),
            ),
          ];
        },
      );
}
