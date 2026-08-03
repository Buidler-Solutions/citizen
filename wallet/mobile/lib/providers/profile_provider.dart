import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/models/profile_details.dart';
import '../data/services/storage_service.dart';
import 'service_providers.dart';

class ProfileState {
  final ProfileDetails details;

  const ProfileState({this.details = const ProfileDetails()});
}

class ProfileNotifier extends StateNotifier<ProfileState> {
  final StorageService _storage;

  ProfileNotifier(this._storage) : super(const ProfileState());

  Future<void> refresh() async {
    final details = await _storage.getProfile();
    state = ProfileState(details: details);
  }

  Future<void> save(ProfileDetails details) async {
    await _storage.saveProfile(details);
    state = ProfileState(details: details);
  }
}

final profileProvider = StateNotifierProvider<ProfileNotifier, ProfileState>((ref) {
  return ProfileNotifier(ref.read(storageServiceProvider));
});
