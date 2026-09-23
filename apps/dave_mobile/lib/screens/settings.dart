import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../app_scope.dart';
import '../push/push_service.dart';
import '../session.dart';
import '../theme.dart';
import '../widgets/common.dart';

class _SettingsData {
  _SettingsData(this.bot, this.notifications, this.serviceRunning, this.batteryExempt);
  final BotState bot;
  final bool notifications;
  final bool serviceRunning;
  final bool batteryExempt;
}

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return LoadedPage<_SettingsData>(
      title: 'Settings',
      load: (api) async {
        final bot = await api.bot();
        return _SettingsData(bot, await Session.notificationsEnabled(), await PushService.isRunning, await PushService.isIgnoringBatteryOptimizations);
      },
      builder: (context, data, reload) => [
        SliverToBoxAdapter(child: _TradingSection(bot: data.bot, reload: reload)),
        SliverToBoxAdapter(child: _NotificationSection(data: data, reload: reload)),
        const SliverToBoxAdapter(child: _ConnectionSection()),
      ],
    );
  }
}

Future<void> _guarded(BuildContext context, Future<void> Function(DaveApi api) action, Future<void> Function() reload) async {
  final scope = AppScope.of(context);
  try {
    await action(scope.api);
    HapticFeedback.selectionClick();
    await reload();
  } on UnpairedException catch (e) {
    scope.onUnpaired(e.message);
  } catch (e) {
    if (context.mounted) await showError(context, e);
  }
}

class _TradingSection extends StatelessWidget {
  const _TradingSection({required this.bot, required this.reload});
  final BotState bot;
  final Future<void> Function() reload;

  @override
  Widget build(BuildContext context) => CupertinoListSection.insetGrouped(
        header: const ListHeader('TRADING'),
        footer: const ListFooter('Watch-only keeps Dave analysing and managing open trades, but he asks you before opening a new one. Stopping never closes open positions.'),
        children: [
          CupertinoListTile(
            leading: const Icon(CupertinoIcons.play_circle),
            title: const Text('Autonomous trading'),
            trailing: CupertinoSwitch(
              value: bot.running,
              onChanged: (v) async {
                if (!v) {
                  final ok = await confirmDestructive(context,
                      title: 'Stop autonomous trading?', message: 'Open positions are not closed.', action: 'Stop trading');
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
            trailing: Row(mainAxisSize: MainAxisSize.min, children: [
              _StepButton(
                icon: CupertinoIcons.minus,
                label: 'Scan less often',
                onTap: bot.intervalMinutes <= bot.minInterval ? null : () => _guarded(context, (api) => api.updateBot(intervalMinutes: bot.intervalMinutes - 1), reload),
              ),
              SizedBox(
                width: 58,
                child: Text('${bot.intervalMinutes} min', textAlign: TextAlign.center, style: const TextStyle(fontFeatures: [FontFeature.tabularFigures()])),
              ),
              _StepButton(
                icon: CupertinoIcons.plus,
                label: 'Scan more often',
                onTap: bot.intervalMinutes >= bot.maxInterval ? null : () => _guarded(context, (api) => api.updateBot(intervalMinutes: bot.intervalMinutes + 1), reload),
              ),
            ]),
          ),
        ],
      );
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
          onPressed: onTap,
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
          await showError(context, 'Notifications are turned off for Dave in Android settings. Turn them on there, then try again.');
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
  Widget build(BuildContext context) => CupertinoListSection.insetGrouped(
        header: const ListHeader('NOTIFICATIONS'),
        footer: const ListFooter(
            'Alerts come straight from your own server -- no Firebase, nothing else to install. Android requires a small ongoing "Dave" notification while Dave stays connected. Some phones also need battery optimisation turned off for Dave, or they cut the connection to save power.'),
        children: [
          CupertinoListTile(
            leading: const Icon(CupertinoIcons.bell),
            title: const Text('Trade alerts'),
            subtitle: Text(data.notifications ? (data.serviceRunning ? 'Connected' : 'Starting…') : 'Off'),
            trailing: CupertinoSwitch(value: data.notifications, onChanged: (v) => _toggle(context, v)),
          ),
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
    return CupertinoListSection.insetGrouped(
      header: const ListHeader('CONNECTION'),
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
            final ok = await confirmDestructive(context,
                title: 'Disconnect this phone?', message: 'You will need a new pairing code from the web panel to connect again.', action: 'Disconnect');
            if (ok) scope.onUnpaired('Disconnected. Get a new pairing code from the web panel to connect again.');
          },
        ),
      ],
    );
  }
}
