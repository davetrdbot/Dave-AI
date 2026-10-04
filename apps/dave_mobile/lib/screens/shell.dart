import 'package:flutter/cupertino.dart';

import 'package:flutter/services.dart';

import '../look.dart';
import '../theme.dart';
import 'brain.dart';
import 'chat.dart';
import 'home.dart';
import 'live.dart';
import 'settings.dart';
import 'skills.dart';
import '../widgets/money_rain.dart';

class _Tab {
  const _Tab(this.label, this.icon, this.activeIcon);
  final String label;
  final IconData icon;
  final IconData activeIcon;
}

const _tabs = [
  _Tab('Home', CupertinoIcons.house, CupertinoIcons.house_fill),
  _Tab('Chat', CupertinoIcons.chat_bubble_2, CupertinoIcons.chat_bubble_2_fill),
  _Tab('Live', CupertinoIcons.waveform_path_ecg, CupertinoIcons.waveform_path_ecg),
  _Tab('Brain', CupertinoIcons.lightbulb, CupertinoIcons.lightbulb_fill),
  _Tab('Skills', CupertinoIcons.square_stack_3d_up, CupertinoIcons.square_stack_3d_up_fill),
  _Tab('Settings', CupertinoIcons.gear_alt, CupertinoIcons.gear_alt_fill),
];

/// Lets a screen switch tabs (Home's round buttons open Chat and Live).
class ShellScope extends InheritedWidget {
  const ShellScope({super.key, required this.goTo, required super.child});
  final void Function(int index) goTo;

  static const home = 0, chat = 1, live = 2;

  static ShellScope? of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<ShellScope>();

  @override
  bool updateShouldNotify(ShellScope oldWidget) => false;
}

/// The app frame: the screens, and a floating pill of round icon buttons -- the selected one
/// lit in the look's accent. The same on Android and iPhone: it's Dave's own look, not either platform's.
///
/// Screens live in an IndexedStack so switching tabs keeps each one's scroll position and loaded
/// data.
class Shell extends StatefulWidget {
  const Shell({super.key});

  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  int _index = 0;

  static const _pages = [HomeScreen(), ChatScreen(), LiveScreen(), BrainScreen(), SkillsScreen(), SettingsScreen()];

  void _goTo(int i) {
    if (i == _index) return;
    HapticFeedback.selectionClick();
    setState(() => _index = i);
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.paddingOf(context).bottom;
    // The chat's own composer sits where the bar is; while typing the bar steps aside.
    final keyboard = MediaQuery.viewInsetsOf(context).bottom > 0;
    return ShellScope(
      goTo: _goTo,
      // Money rain over everything when a trade hits its take profit.
      child: MoneyRain(child: Stack(children: [
        Positioned.fill(child: IndexedStack(index: _index, children: _pages)),
        // Chat is full screen with its own back button -- the bar steps aside there.
        if (!keyboard && _index != ShellScope.chat)
          Positioned(
            left: 0,
            right: 0,
            bottom: bottom + 12,
            height: 58,
            child: Center(
              child: Glass(
                radius: 40,
                child: Padding(
                  padding: const EdgeInsets.all(6),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    for (var i = 0; i < _tabs.length; i++) ...[
                      if (i > 0) const SizedBox(width: 3),
                      _TabButton(tab: _tabs[i], selected: i == _index, onTap: () => _goTo(i)),
                    ],
                  ]),
                ),
              ),
            ),
          ),
      ])),
    );
  }
}

class _TabButton extends StatelessWidget {
  const _TabButton({required this.tab, required this.selected, required this.onTap});
  final _Tab tab;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Semantics(
      button: true,
      selected: selected,
      label: tab.label,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOut,
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: selected ? look.tabActive : look.tabIdle,
            shape: BoxShape.circle,
            boxShadow: selected && look.dark ? [BoxShadow(color: look.tabActive.withValues(alpha: 0.45), blurRadius: 16)] : null,
          ),
          child: Icon(selected ? tab.activeIcon : tab.icon, size: 21, color: selected ? look.tabActiveIcon : look.tabIcon),
        ),
      ),
    );
  }
}
