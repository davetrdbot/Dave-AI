import 'package:flutter/widgets.dart';

import 'api/client.dart';

/// What every screen needs from the app: the paired API client, and the one thing to do when the
/// server stops recognising this phone (go back to the connect screen, and say why).
class AppScope extends InheritedWidget {
  const AppScope({super.key, required this.api, required this.onUnpaired, required super.child});

  final DaveApi api;
  final void Function(String reason) onUnpaired;

  static AppScope of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<AppScope>();
    assert(scope != null, 'AppScope missing above this widget');
    return scope!;
  }

  @override
  bool updateShouldNotify(AppScope oldWidget) => api != oldWidget.api;
}
