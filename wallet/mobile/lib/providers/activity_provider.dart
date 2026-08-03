import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/models/activity_entry.dart';
import '../data/services/storage_service.dart';
import 'service_providers.dart';

class ActivityState {
  final List<ActivityEntry> entries;

  const ActivityState({this.entries = const []});
}

class ActivityNotifier extends StateNotifier<ActivityState> {
  final StorageService _storage;

  ActivityNotifier(this._storage) : super(const ActivityState());

  Future<void> refresh() async {
    final entries = await _storage.getActivity();
    state = ActivityState(entries: entries);
  }

  Future<void> record(ActivityEntry entry) async {
    await _storage.appendActivity(entry);
    await refresh();
  }
}

final activityProvider = StateNotifierProvider<ActivityNotifier, ActivityState>((ref) {
  return ActivityNotifier(ref.read(storageServiceProvider));
});
