import 'package:flutter/cupertino.dart';

import '../api/models.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// MetaTrader 5 in Dave's own container: the account it's logged into, the EA's chart, how often
/// the EA reports, and a restart. The same controls as /mt5 in Telegram.
///
/// The password is typed into a hidden field and sent to the server once; it goes straight to the
/// container and is never shown or stored on the phone.
class Mt5Page extends StatelessWidget {
  const Mt5Page({super.key});

  @override
  Widget build(BuildContext context) => LoadedPage<Mt5View>(
        title: 'MetaTrader 5',
        load: (api) => api.mt5(),
        builder: (context, v, reload) {
          Future<void> act(String action, [Map<String, Object?> fields = const {}]) async {
            if (await runAction(context, (api) => api.mt5Action(action, fields))) await reload();
          }

          final tone = !v.hasAgent || !v.configured
              ? CupertinoColors.systemGrey
              : v.login == 'logged-in' && v.running
                  ? CupertinoColors.systemGreen
                  : v.login == 'failed' || !v.running
                      ? CupertinoColors.systemRed
                      : CupertinoColors.systemOrange;
          final a = v.account;
          return [
            SliverToBoxAdapter(
              child: CupertinoListSection.insetGrouped(
                header: const ListHeader('Status'),
                footer: const ListFooter('MetaTrader 5 runs next to Dave with his EA already on a chart, so you don\'t need a Windows VPS.'),
                children: [
                  CupertinoListTile(
                    leading: Icon(CupertinoIcons.circle_fill, size: 12, color: resolve(context, tone)),
                    title: Text(v.summary, maxLines: 4),
                  ),
                  if (a != null) CupertinoListTile(title: const Text('Account'), additionalInfo: Text('${a.login} · ${a.server}')),
                  if (v.lastReportAt != null) CupertinoListTile(title: const Text('EA last reported'), additionalInfo: Text(formatAgo(v.lastReportAt!))),
                ],
              ),
            ),
            if (!v.hasAgent)
              SliverToBoxAdapter(
                child: CupertinoListSection.insetGrouped(
                  header: const ListHeader('Not set up yet'),
                  footer: const ListFooter('The MT5 service has to be added next to Dave on the server first. After that, all you enter here is your MT5 login, password and server.'),
                  children: const [CupertinoListTile(title: Text('Waiting for the MT5 service'))],
                ),
              )
            else ...[
              SliverToBoxAdapter(
                child: CupertinoListSection.insetGrouped(
                  header: const ListHeader('Account'),
                  footer: const ListFooter('Dave compiles his EA, starts MT5 logged in, and puts the EA on a chart. Connecting takes a minute or two.'),
                  children: [
                    CupertinoListTile(
                      leading: Icon(CupertinoIcons.person_crop_circle_badge_plus, color: resolve(context, CupertinoColors.systemBlue)),
                      title: Text(v.configured ? 'Change account' : 'Connect account', style: TextStyle(color: resolve(context, CupertinoColors.systemBlue))),
                      onTap: v.installed ? () => _connect(context, act) : null,
                    ),
                  ],
                ),
              ),
              if (v.configured && a != null)
                SliverToBoxAdapter(
                  child: CupertinoListSection.insetGrouped(
                    header: const ListHeader('Market Watch'),
                    footer: const ListFooter('The pairs MT5 has in Market Watch. Each one gets its own chart. Changing them restarts MT5 on the same account.'),
                    children: [
                      CupertinoListTile(
                        title: const Text('Pairs'),
                        subtitle: Text(v.marketWatch.isEmpty ? 'Only the EA\'s chart' : v.marketWatch.join(', '), maxLines: 3),
                        trailing: const CupertinoListTileChevron(),
                        onTap: () async {
                          final s = await promptText(context,
                              title: 'Market Watch', message: 'Pairs separated by commas, exactly as your broker names them.', initial: v.marketWatch.join(', '), placeholder: 'VOL_80, BOOM_100, EURUSD');
                          if (s == null || !context.mounted) return;
                          if (s.trim().isEmpty) return showError(context, 'Enter at least one pair.');
                          await act('settings', {'marketWatch': s});
                        },
                      ),
                      if (v.pairGroup.isNotEmpty && v.pairGroup.join(',') != v.marketWatch.join(','))
                        CupertinoListTile(
                          leading: Icon(CupertinoIcons.square_stack_3d_up, color: resolve(context, CupertinoColors.systemBlue)),
                          title: Text('Use my pair group', style: TextStyle(color: resolve(context, CupertinoColors.systemBlue))),
                          subtitle: Text(v.pairGroup.join(', '), maxLines: 2),
                          onTap: () => act('settings', {'marketWatch': v.pairGroup}),
                        ),
                    ],
                  ),
                ),
              if (v.configured && a != null)
                SliverToBoxAdapter(
                  child: CupertinoListSection.insetGrouped(
                    header: const ListHeader('EA'),
                    footer: const ListFooter('The chart is only where the EA sits -- it analyses every symbol Dave asks for. Changes restart MT5 on the same account.'),
                    children: [
                      CupertinoListTile(
                        title: const Text('Chart symbol'),
                        additionalInfo: Text(a.symbol),
                        trailing: const CupertinoListTileChevron(),
                        onTap: () async {
                          final s = await promptText(context, title: 'Chart symbol', message: 'Exactly as your broker names it.', initial: a.symbol, placeholder: 'VOL_80');
                          if (s != null && s.isNotEmpty && s != a.symbol && context.mounted) await act('settings', {'symbol': s});
                        },
                      ),
                      CupertinoListTile(
                        title: const Text('Timeframe'),
                        additionalInfo: Text(a.period),
                        trailing: const CupertinoListTileChevron(),
                        onTap: () async {
                          final p = await _pickPeriod(context, a.period);
                          if (p != null && p != a.period && context.mounted) await act('settings', {'period': p});
                        },
                      ),
                      CupertinoListTile(
                        title: const Text('Report every'),
                        additionalInfo: Text('${v.pushSeconds}s'),
                        trailing: const CupertinoListTileChevron(),
                        onTap: () async {
                          final s = await promptText(context, title: 'Report interval', message: 'Seconds between EA reports, 2 to 120.', initial: '${v.pushSeconds}', keyboardType: TextInputType.number);
                          final n = int.tryParse(s ?? '');
                          if (n == null || !context.mounted) return;
                          if (n < 2 || n > 120) return showError(context, 'Use a whole number from 2 to 120.');
                          if (n != v.pushSeconds) await act('settings', {'inputs': {'PushSeconds': n}});
                        },
                      ),
                      CupertinoListTile(
                        leading: Icon(CupertinoIcons.arrow_clockwise, color: resolve(context, CupertinoColors.systemBlue)),
                        title: Text('Restart MT5', style: TextStyle(color: resolve(context, CupertinoColors.systemBlue))),
                        onTap: () => act('restart'),
                      ),
                    ],
                  ),
                ),
            ],
          ];
        },
      );

  Future<void> _connect(BuildContext context, Future<void> Function(String, [Map<String, Object?>]) act) async {
    final login = await promptText(context, title: 'Account number', message: 'Your MT5 login.', keyboardType: TextInputType.number, action: 'Next');
    if (login == null || login.isEmpty || !context.mounted) return;
    final password = await promptText(context, title: 'Password', message: 'Sent to your MT5 container only. Not stored on this phone.', obscure: true, action: 'Next');
    if (password == null || password.isEmpty || !context.mounted) return;
    final server = await promptText(context, title: 'Server', message: 'Exactly as MT5 shows it at login.', placeholder: 'Deriv-Demo', action: 'Connect');
    if (server == null || server.isEmpty || !context.mounted) return;
    await act('connect', {'login': login, 'password': password, 'server': server});
  }

  Future<String?> _pickPeriod(BuildContext context, String current) => showCupertinoModalPopup<String>(
        context: context,
        builder: (ctx) => CupertinoActionSheet(
          title: const Text('Timeframe'),
          actions: [
            for (final p in const ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'])
              CupertinoActionSheetAction(isDefaultAction: p == current, onPressed: () => Navigator.pop(ctx, p), child: Text(p)),
          ],
          cancelButton: CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
        ),
      );
}
