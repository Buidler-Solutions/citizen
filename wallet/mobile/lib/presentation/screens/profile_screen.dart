import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/profile_details.dart';
import '../../providers/profile_provider.dart';

class ProfileScreen extends ConsumerStatefulWidget {
  const ProfileScreen({super.key});

  @override
  ConsumerState<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends ConsumerState<ProfileScreen> {
  final _nameController = TextEditingController();
  final _emailController = TextEditingController();
  final _addressController = TextEditingController();
  final _professionController = TextEditingController();
  bool _initialized = false;

  @override
  void dispose() {
    _nameController.dispose();
    _emailController.dispose();
    _addressController.dispose();
    _professionController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final profile = ref.watch(profileProvider);

    if (!_initialized) {
      _nameController.text = profile.details.fullName;
      _emailController.text = profile.details.email;
      _addressController.text = profile.details.address;
      _professionController.text = profile.details.profession;
      _initialized = true;
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Profile'),
        actions: [
          IconButton(
            onPressed: _save,
            icon: const Icon(Icons.save),
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            CircleAvatar(
              radius: 48,
              backgroundColor: Theme.of(context).colorScheme.primary,
              child: Text(
                profile.details.fullName.isNotEmpty
                    ? profile.details.fullName.substring(0, 1).toUpperCase()
                    : '?',
                style: const TextStyle(fontSize: 32, color: Colors.white),
              ),
            ),
            const SizedBox(height: 24),
            TextField(
              controller: _nameController,
              decoration: const InputDecoration(labelText: 'Full Name'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _emailController,
              decoration: const InputDecoration(labelText: 'Email'),
              keyboardType: TextInputType.emailAddress,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _addressController,
              decoration: const InputDecoration(labelText: 'Address'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _professionController,
              decoration: const InputDecoration(labelText: 'Profession'),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Icon(
                  profile.details.kycVerified ? Icons.verified : Icons.pending,
                  color: profile.details.kycVerified ? Colors.green : Colors.orange,
                  size: 20,
                ),
                const SizedBox(width: 8),
                Text(profile.details.kycVerified ? 'KYC Verified' : 'KYC Pending'),
              ],
            ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: _save,
              child: const Text('Save Profile'),
            ),
          ],
        ),
      ),
    );
  }

  void _save() {
    final details = ProfileDetails(
      fullName: _nameController.text.trim(),
      email: _emailController.text.trim(),
      address: _addressController.text.trim(),
      profession: _professionController.text.trim(),
      kycVerified: ref.read(profileProvider).details.kycVerified,
    );
    ref.read(profileProvider.notifier).save(details);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Profile saved')),
    );
  }
}
