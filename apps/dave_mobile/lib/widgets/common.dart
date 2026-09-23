import 'dart:async';

import 'package:flutter/cupertino.dart';

import '../api/client.dart';
import '../app_scope.dart';
import '../theme.dart';

/// Space the floating tab bar occupies, so the last row of every screen can scroll clear of it.
double tabBarClearance(BuildContext context) => 110 + MediaQuery.paddingOf(context).bottom;

/// A calm, opaque content card. Deliberately NOT glass -- glass is for chrome only.
class ContentCard extends StatelessWidget {
  const ContentCard({super.key, required this.child, this.padding = const EdgeInsets.all(Space.s4)});
  final Widget child;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.symmetric(horizontal: Space.s4, vertical: Space.s2),
        padding: padding,
        decoration: BoxDecoration(
          color: resolve(context, CupertinoColors.secondarySystemGroupedBackground),
          borderRadius: BorderRadius.circular(14),
        ),
        child: child,
      );
}

/// Small caps section label, the iOS grouped-list header style.
class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Text(
        text.toUpperCase(),
        style: TextStyle(fontSize: 13, letterSpacing: 0.2, fontWeight: FontWeight.w500, color: resolve(context, CupertinoColors.secondaryLabel)),
      );
}

/// One number and what it means. The number carries the hierarchy, not a box.
class StatTile extends StatelessWidget {
  const StatTile({super.key, required this.value, required this.label, this.color});
  final String value;
  final String label;
  final Color? color;

  @override
  Widget build(BuildContext context) => Padding(
        // The gap is what keeps three figures in a row readable as three figures.
        padding: const EdgeInsets.only(right: Space.s2),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Money is never truncated with an ellipsis -- a large balance shrinks to fit instead.
            FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(
                value,
                maxLines: 1,
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, letterSpacing: -0.2, color: color ?? resolve(context, CupertinoColors.label), fontFeatures: const [FontFeature.tabularFigures()]),
              ),
            ),
            const SizedBox(height: 2),
            Text(label, style: TextStyle(fontSize: 13, color: resolve(context, CupertinoColors.secondaryLabel))),
          ],
        ),
      );
}

/// The small grey caption above a grouped list -- the HIG's section header.
///
/// Flutter's inset-grouped header defaults to a large bold title; this restores the quiet
/// footnote-sized label every Apple settings list uses, so section names never compete with the
/// content under them.
class ListHeader extends StatelessWidget {
  const ListHeader(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Text(
        text.toUpperCase(),
        style: TextStyle(fontSize: 13, fontWeight: FontWeight.w400, letterSpacing: 0.2, color: resolve(context, CupertinoColors.secondaryLabel)),
      );
}

/// The small grey note under a grouped list -- same reasoning as [ListHeader], sentence case.
class ListFooter extends StatelessWidget {
  const ListFooter(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Text(text, style: TextStyle(fontSize: 13, height: 1.35, color: resolve(context, CupertinoColors.secondaryLabel)));
}

/// A status chip. Tinted, never glowing.
class Pill extends StatelessWidget {
  const Pill({super.key, required this.text, required this.good});
  final String text;
  final bool good;

  @override
  Widget build(BuildContext context) {
    final c = resolve(context, good ? CupertinoColors.systemGreen : CupertinoColors.systemRed);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Space.s2, vertical: 3),
      decoration: BoxDecoration(color: c.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(6)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 6, height: 6, decoration: BoxDecoration(color: c, shape: BoxShape.circle)),
        const SizedBox(width: 5),
        Text(text, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c)),
      ]),
    );
  }
}

/// An empty state says WHY it is empty -- HIG's ContentUnavailableView, not a blank area.
class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, required this.message, this.action});
  final IconData icon;
  final String title;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: Space.s6, vertical: Space.s6),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 44, color: resolve(context, CupertinoColors.tertiaryLabel)),
          const SizedBox(height: Space.s3),
          Text(title, textAlign: TextAlign.center, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600)),
          const SizedBox(height: Space.s2),
          Text(message, textAlign: TextAlign.center, style: TextStyle(fontSize: 15, color: resolve(context, CupertinoColors.secondaryLabel))),
          if (action != null) ...[const SizedBox(height: Space.s4), action!],
        ]),
      );
}

/// Every data screen in the app: collapsing large title, pull to refresh, honest loading and error
/// states, and a hand-off to the connect screen if the server stops recognising this phone.
class LoadedPage<T> extends StatefulWidget {
  const LoadedPage({super.key, required this.title, required this.load, required this.builder, this.trailing, this.autoRefresh});

  final String title;
  final Future<T> Function(DaveApi api) load;
  final List<Widget> Function(BuildContext context, T data, Future<void> Function() reload) builder;
  final Widget? trailing;

  /// Re-fetch on a timer while the screen exists -- for the live dashboard.
  final Duration? autoRefresh;

  @override
  State<LoadedPage<T>> createState() => _LoadedPageState<T>();
}

class _LoadedPageState<T> extends State<LoadedPage<T>> {
  T? _data;
  Object? _error;
  Timer? _timer;
  bool _inFlight = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _reload());
    if (widget.autoRefresh != null) _timer = Timer.periodic(widget.autoRefresh!, (_) => _reload());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _reload() async {
    if (_inFlight || !mounted) return;
    _inFlight = true;
    final scope = AppScope.of(context);
    try {
      final data = await widget.load(scope.api);
      if (!mounted) return;
      setState(() {
        _data = data;
        _error = null;
      });
    } on UnpairedException catch (e) {
      scope.onUnpaired(e.message);
    } catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      _inFlight = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final data = _data;
    return CupertinoPageScaffold(
      backgroundColor: resolve(context, CupertinoColors.systemGroupedBackground),
      child: CustomScrollView(
        physics: const BouncingScrollPhysics(parent: AlwaysScrollableScrollPhysics()),
        slivers: [
          // Native large title that collapses to an inline one on scroll -- and the nav bar's own
          // translucent material is the ONE other piece of glass in the app.
          // Each tab's bar needs its own hero tag: all four tabs sit in one IndexedStack under one
          // navigator, and with the shared default tag, pushing any route (a skill's detail page)
          // finds four identical heroes and asserts.
          CupertinoSliverNavigationBar(largeTitle: Text(widget.title), trailing: widget.trailing, heroTag: 'nav:${widget.title}'),
          CupertinoSliverRefreshControl(onRefresh: _reload),
          if (data == null && _error == null)
            const SliverFillRemaining(hasScrollBody: false, child: Center(child: CupertinoActivityIndicator(radius: 14)))
          else if (data == null)
            SliverFillRemaining(
              hasScrollBody: false,
              child: Center(
                child: EmptyState(
                  icon: CupertinoIcons.wifi_exclamationmark,
                  title: 'Could not load',
                  message: '$_error',
                  action: CupertinoButton.filled(onPressed: _reload, child: const Text('Try again')),
                ),
              ),
            )
          else ...[
            // A stale screen says it is stale, rather than silently showing old numbers as current.
            if (_error != null)
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(Space.s4, 0, Space.s4, Space.s2),
                  child: Text('Showing the last update -- could not refresh: $_error',
                      style: TextStyle(fontSize: 13, color: resolve(context, CupertinoColors.systemOrange))),
                ),
              ),
            ...widget.builder(context, data, _reload),
          ],
          SliverToBoxAdapter(child: SizedBox(height: tabBarClearance(context))),
        ],
      ),
    );
  }
}

/// A confirmation for anything destructive -- HIG: confirm before, not undo after.
Future<bool> confirmDestructive(BuildContext context, {required String title, required String message, required String action}) async {
  final result = await showCupertinoModalPopup<bool>(
    context: context,
    builder: (ctx) => CupertinoActionSheet(
      title: Text(title),
      message: Text(message),
      actions: [CupertinoActionSheetAction(isDestructiveAction: true, onPressed: () => Navigator.pop(ctx, true), child: Text(action))],
      cancelButton: CupertinoActionSheetAction(isDefaultAction: true, onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
    ),
  );
  return result == true;
}

/// A short, non-blocking error alert with the real reason.
Future<void> showError(BuildContext context, Object error) => showCupertinoDialog<void>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: const Text('Something went wrong'),
        content: Text('$error'),
        actions: [CupertinoDialogAction(isDefaultAction: true, onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
      ),
    );
