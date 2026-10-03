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

// ---------------------------------------------------------------------------------------------

/// E2B and Firecrawl keys -- the services Dave's script and web tools run on. A key is typed once
/// and only ever shown back masked.
class ServiceKeysPage extends StatelessWidget {
  const ServiceKeysPage({super.key});

  @override
  Widget build(BuildContext context) => LoadedPage<Map<String, dynamic>>(
        title: 'Service keys',
        load: (api) => api.serviceKeys(),
        builder: (context, d, reload) {
          Future<void> act(Map<String, Object?> body) async {
            if (await runAction(context, (api) => api.serviceKeysAction(body))) await reload();
          }

          Widget service(String id) {
            final m = d[id] is Map ? Map<String, dynamic>.from(d[id] as Map) : const <String, dynamic>{};
            final keys = _list(m['keys']);
            final title = '${m['title'] ?? id}';
            return _section(context, header: title, footer: '${m['about'] ?? ''} Get a key at ${m['link'] ?? 'their website'}.', children: [
              if (keys.isEmpty) CupertinoListTile(title: Text('No key yet', style: TextStyle(color: resolve(context, CupertinoColors.secondaryLabel)))),
              for (final k in keys)
                CupertinoListTile(
                  leading: const Icon(CupertinoIcons.lock_fill),
                  title: Text('${k['label']}'),
                  subtitle: Text('${k['key'] ?? ''}'),
                  trailing: CupertinoButton(
                    padding: EdgeInsets.zero,
                    minimumSize: const Size(32, 32),
                    onPressed: () async {
                      final ok = await confirmDestructive(context, title: 'Remove this $title key?', message: 'Dave stops using it straight away.', action: 'Remove');
                      if (ok && context.mounted) await act({'action': 'remove', 'service': id, 'keyId': k['id']});
                    },
                    child: Icon(CupertinoIcons.minus_circle_fill, color: Look.of(context).down, size: 22),
                  ),
                ),
              CupertinoListTile(
                leading: Icon(CupertinoIcons.add_circled_solid, color: Look.of(context).accent),
                title: Text('Add $title key', style: TextStyle(color: Look.of(context).accent)),
                onTap: () async {
                  final key = await promptText(context, title: '$title API key', message: 'Paste the key. It is stored on your server and never shown in full again.', obscure: true, action: 'Add');
                  if (key == null || key.trim().isEmpty || !context.mounted) return;
                  await act({'action': 'add', 'service': id, 'apiKey': key.trim()});
                },
              ),
            ]);
          }

          return [SliverToBoxAdapter(child: service('e2b')), SliverToBoxAdapter(child: service('firecrawl'))];
        },
      );
}

// ---------------------------------------------------------------------------------------------

/// The groups of symbols Dave hunts: create, edit, delete, and pick the active and fallback one.
class PairGroupsPage extends StatelessWidget {
  const PairGroupsPage({super.key});

  @override
  Widget build(BuildContext context) => LoadedPage<Map<String, dynamic>>(
        title: 'Pair groups',
        load: (api) => api.pairGroups(),
        builder: (context, d, reload) {
          Future<void> act(Map<String, Object?> body) async {
            if (await runAction(context, (api) => api.pairGroupsAction(body))) await reload();
          }

          Future<void> edit([Map<String, dynamic>? g]) async {
            final saved = await pushScoped<bool>(
              context,
              EditorPage(
                title: g == null ? 'New group' : 'Edit ${g['name']}',
                fields: [
                  EditorField(label: 'Name', initial: '${g?['name'] ?? ''}', placeholder: 'Boom & Crash'),
                  EditorField(label: 'Symbols', initial: g == null ? '' : ((g['symbols'] as List?) ?? const []).join(', '), placeholder: 'BOOM_1000, CRASH_1000, VOL_75', multiline: true),
                ],
                footer: 'Symbols exactly as MT5 names them, separated by commas or spaces.',
                onSave: (v) async {
                  await AppScope.of(context).api.pairGroupsAction({'action': 'save', if (g != null) 'id': g['id'], 'name': v[0], 'symbols': v[1]});
                },
              ),
            );
            if (saved == true) await reload();
          }

          final groups = _list(d['groups']);
          final active = d['activeGroupId'];
          final fallback = d['fallbackGroupId'];
          final rounds = d['fallbackAfterRounds'] ?? 3;
          String nameOf(Object? id) => '${groups.firstWhere((g) => g['id'] == id, orElse: () => const {'name': 'None'})['name']}';

          Future<void> pickBackup() async {
            final choice = await showCupertinoModalPopup<String>(
              context: context,
              builder: (ctx) => CupertinoActionSheet(
                title: const Text('Backup group'),
                message: Text('Dave checks these pairs after $rounds full rounds of your main group with no trade.'),
                actions: [
                  CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, 'none'), child: Text(fallback == null ? 'None (current)' : 'None')),
                  for (final g in groups)
                    if (g['id'] != active)
                      CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, '${g['id']}'), child: Text(g['id'] == fallback ? '${g['name']} (current)' : '${g['name']}')),
                ],
                cancelButton: CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
              ),
            );
            if (choice == null || !context.mounted) return;
            await act({'action': 'fallback', 'id': choice});
          }

          return [
            SliverToBoxAdapter(
              child: _section(context,
                  header: 'Main and backup',
                  footer: 'Dave hunts the main group. After $rounds full rounds of it with no trade, he checks the backup group once, then goes back to the main group.',
                  children: [
                    CupertinoListTile(
                      title: const Text('Main group'),
                      additionalInfo: Text(active == null ? 'None' : nameOf(active)),
                    ),
                    CupertinoListTile(
                      key: const ValueKey('pick-backup'),
                      title: const Text('Backup group'),
                      additionalInfo: Text(fallback == null ? 'None' : nameOf(fallback)),
                      trailing: const CupertinoListTileChevron(),
                      onTap: pickBackup,
                    ),
                  ]),
            ),
            SliverToBoxAdapter(
              child: _section(context,
                  header: 'Groups',
                  footer: 'Tap a group to make it the main group.',
                  children: [
                    for (final g in groups)
                      CupertinoListTile(
                        leading: Icon(g['id'] == active ? CupertinoIcons.checkmark_circle_fill : CupertinoIcons.circle, color: g['id'] == active ? Look.of(context).accent : null),
                        title: Text('${g['name']}'),
                        subtitle: Text(
                          [if (g['id'] == active) 'Main', if (g['id'] == fallback) 'Backup', ((g['symbols'] as List?) ?? const []).join(', ')].join(' · '),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                        trailing: CupertinoButton(
                          padding: EdgeInsets.zero,
                          minimumSize: const Size(32, 32),
                          onPressed: () async {
                            final choice = await showCupertinoModalPopup<String>(
                              context: context,
                              builder: (ctx) => CupertinoActionSheet(
                                title: Text('${g['name']}'),
                                actions: [
                                  CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, 'edit'), child: const Text('Edit symbols')),
                                  if (g['id'] != fallback && g['id'] != active) CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, 'fallback'), child: const Text('Use as backup')),
                                  CupertinoActionSheetAction(isDestructiveAction: true, onPressed: () => Navigator.pop(ctx, 'delete'), child: const Text('Delete group')),
                                ],
                                cancelButton: CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
                              ),
                            );
                            if (!context.mounted) return;
                            if (choice == 'edit') return edit(g);
                            if (choice == 'fallback') return act({'action': 'fallback', 'id': g['id']});
                            if (choice != 'delete') return;
                            final ok = await confirmDestructive(context, title: 'Delete ${g['name']}?', message: 'Open trades are not touched.', action: 'Delete');
                            if (ok) await act({'action': 'delete', 'id': g['id']});
                          },
                          child: const Icon(CupertinoIcons.ellipsis_circle, size: 22),
                        ),
                        onTap: g['id'] == active ? null : () => act({'action': 'activate', 'id': g['id']}),
                      ),
                    CupertinoListTile(
                      leading: Icon(CupertinoIcons.add_circled_solid, color: Look.of(context).accent),
                      title: Text('New group', style: TextStyle(color: Look.of(context).accent)),
                      onTap: () => edit(),
                    ),
                  ]),
            ),
          ];
        },
      );
}

// ---------------------------------------------------------------------------------------------

/// Which timeframes and analysis types Dave pulls from MT5 on each scan -- fewer is faster.
class AnalysisScopePage extends StatelessWidget {
  const AnalysisScopePage({super.key});

  @override
  Widget build(BuildContext context) => LoadedPage<Map<String, dynamic>>(
        title: 'What Dave analyses',
        load: (api) => api.analysisScope(),
        builder: (context, d, reload) {
          Future<void> act(Map<String, Object?> body) async {
            if (await runAction(context, (api) => api.analysisScopeAction(body))) await reload();
          }

          List<String> strings(Object? v) => v is List ? v.map((e) => '$e').toList() : <String>[];
          final tfs = strings(d['timeframes']);
          final eps = strings(d['endpoints']);
          final allTf = strings(d['allTimeframes']);
          final allEp = strings(d['allEndpoints']);
          final everything = d['mode'] == 'all';
          final groups = d['groups'] is List ? (d['groups'] as List).whereType<Map>().toList() : <Map>[];
          void toggleEp(String ep) {
            final next = eps.contains(ep) ? (eps.where((x) => x != ep).toList()) : [...eps, ep];
            if (next.isEmpty) return;
            act({'action': 'endpoints', 'endpoints': next});
          }

          return [
            SliverToBoxAdapter(
              child: _section(context, header: 'Scope', footer: 'Everything is the most thorough and the slowest. Trimming analysis types Dave never uses makes each scan faster.', children: [
                CupertinoListTile(
                  title: const Text('Analyse everything'),
                  trailing: CupertinoSwitch(activeTrackColor: Look.of(context).accent, value: everything, onChanged: everything ? null : (_) => act({'action': 'all'})),
                ),
              ]),
            ),
            SliverToBoxAdapter(
              child: _section(context, header: 'Timeframes', children: [
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: Wrap(spacing: 8, runSpacing: 8, children: [
                    for (final tf in allTf)
                      _Chip(
                        label: tf,
                        on: tfs.contains(tf),
                        onTap: () {
                          final next = tfs.contains(tf) ? (tfs.where((x) => x != tf).toList()) : [...tfs, tf];
                          if (next.isEmpty) return;
                          act({'action': 'timeframes', 'timeframes': next});
                        },
                      ),
                  ]),
                ),
              ]),
            ),
            if (groups.isEmpty)
              SliverToBoxAdapter(
                child: _section(context, header: 'Analysis types (${eps.length} of ${allEp.length})', children: [
                  Padding(
                    padding: const EdgeInsets.all(12),
                    child: Wrap(spacing: 6, runSpacing: 6, children: [
                      for (final ep in allEp) _Chip(label: ep.replaceAll('_', ' '), on: eps.contains(ep), onTap: () => toggleEp(ep)),
                    ]),
                  ),
                ]),
              ),
            for (final g in groups)
              SliverToBoxAdapter(
                child: _section(context, header: '${g['group']}', children: [
                  for (final e in (g['endpoints'] is List ? g['endpoints'] as List : const []))
                    if (e is Map)
                      CupertinoListTile(
                        title: Text('${e['id']}'.replaceAll('_', ' ')),
                        subtitle: Text('${e['contains'] ?? ''}', maxLines: 20, style: TextStyle(fontSize: 12, color: resolve(context, CupertinoColors.secondaryLabel))),
                        trailing: CupertinoSwitch(
                          activeTrackColor: Look.of(context).accent,
                          value: eps.contains('${e['id']}'),
                          onChanged: (_) => toggleEp('${e['id']}'),
                        ),
                      ),
                ]),
              ),
          ];
        },
      );
}

class _Chip extends StatelessWidget {
  const _Chip({required this.label, required this.on, required this.onTap});
  final String label;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 160),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(color: on ? look.accent : look.chip, borderRadius: BorderRadius.circular(14)),
        child: Text(label, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: on ? look.tabActiveIcon : resolve(context, CupertinoColors.label))),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------

/// MCP servers: extra tool servers Dave can connect to, and the Lovable image MCP.
class McpPage extends StatelessWidget {
  const McpPage({super.key});

  @override
  Widget build(BuildContext context) => LoadedPage<Map<String, dynamic>>(
        title: 'MCP servers',
        load: (api) => api.mcp(),
        builder: (context, d, reload) {
          Future<void> act(Map<String, Object?> body) async {
            if (await runAction(context, (api) => api.mcpAction(body))) await reload();
          }

          final servers = _list(d['servers']);
          final lovable = d['lovable'] is Map ? Map<String, dynamic>.from(d['lovable'] as Map) : const <String, dynamic>{};
          return [
            SliverToBoxAdapter(
              child: _section(context,
                  header: 'Servers',
                  footer: 'Dave connects to a saved server when he needs its tools (ask him, or /mcp in Telegram). Tokens are stored on your server and never shown again.',
                  children: [
                    if (servers.isEmpty) CupertinoListTile(title: Text('No servers yet', style: TextStyle(color: resolve(context, CupertinoColors.secondaryLabel)))),
                    for (final m in servers)
                      CupertinoListTile(
                        leading: Container(
                          width: 10,
                          height: 10,
                          decoration: BoxDecoration(shape: BoxShape.circle, color: m['connected'] == true ? Look.of(context).up : resolve(context, CupertinoColors.systemGrey3)),
                        ),
                        title: Text('${m['name']}'),
                        subtitle: Text('${m['url']}${m['hasToken'] == true ? ' · token set' : ''}', maxLines: 1, overflow: TextOverflow.ellipsis),
                        trailing: CupertinoButton(
                          padding: EdgeInsets.zero,
                          minimumSize: const Size(32, 32),
                          onPressed: () async {
                            final ok = await confirmDestructive(context, title: 'Remove ${m['name']}?', message: 'Dave can no longer connect to it.', action: 'Remove');
                            if (ok) await act({'action': 'remove', 'id': m['id']});
                          },
                          child: Icon(CupertinoIcons.minus_circle_fill, color: Look.of(context).down, size: 22),
                        ),
                      ),
                    CupertinoListTile(
                      leading: Icon(CupertinoIcons.add_circled_solid, color: Look.of(context).accent),
                      title: Text('Add server', style: TextStyle(color: Look.of(context).accent)),
                      onTap: () async {
                        final saved = await pushScoped<bool>(
                          context,
                          EditorPage(
                            title: 'Add MCP server',
                            fields: const [
                              EditorField(label: 'Name', placeholder: 'My tools', required: false),
                              EditorField(label: 'Server address', placeholder: 'https://example.com/mcp'),
                              EditorField(label: 'Token (optional)', required: false),
                            ],
                            onSave: (v) async {
                              await AppScope.of(context).api.mcpAction({'action': 'add', 'name': v[0], 'url': v[1], 'token': v[2]});
                            },
                          ),
                        );
                        if (saved == true) await reload();
                      },
                    ),
                  ]),
            ),
            SliverToBoxAdapter(
              child: _section(context, header: 'Lovable image MCP', footer: 'Lets Dave generate images through your Lovable MCP.', children: [
                CupertinoListTile(
                  title: const Text('Address'),
                  additionalInfo: Text(lovable['url'] == null ? 'Not set' : 'Set'),
                  subtitle: lovable['url'] == null ? null : Text('${lovable['url']}', maxLines: 1, overflow: TextOverflow.ellipsis),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () async {
                    final url = await promptText(context, title: 'Lovable MCP address', initial: '${lovable['url'] ?? ''}', placeholder: 'https://…', keyboardType: TextInputType.url);
                    if (url != null && context.mounted) await act({'action': 'lovable', 'url': url});
                  },
                ),
                CupertinoListTile(
                  title: const Text('Token'),
                  additionalInfo: Text(lovable['tokenSet'] == true ? 'Set' : 'Not set'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () async {
                    final token = await promptText(context, title: 'Lovable MCP token', obscure: true);
                    if (token != null && context.mounted) await act({'action': 'lovable', 'token': token});
                  },
                ),
              ]),
            ),
          ];
        },
      );
}
