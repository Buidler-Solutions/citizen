import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/network_config.dart';
import '../../providers/security_provider.dart';
import '../../providers/network_provider.dart';
import '../../providers/direct_submit_provider.dart';
import '../../core/config/app_config.dart';

class SecurityScreen extends ConsumerStatefulWidget {
  const SecurityScreen({super.key});

  @override
  ConsumerState<SecurityScreen> createState() => _SecurityScreenState();
}

class _SecurityScreenState extends ConsumerState<SecurityScreen> {
  final _passwordController = TextEditingController();
  bool _obscurePassword = true;

  @override
  void dispose() {
    _passwordController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final security = ref.watch(securityProvider);
    final network = ref.watch(networkProvider);
    final submit = ref.watch(directSubmitProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Security')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Lock state card
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Icon(
                          security.isUnlocked ? Icons.lock_open : Icons.lock,
                          color: security.isUnlocked ? Colors.green : Colors.orange,
                        ),
                        const SizedBox(width: 8),
                        Text(
                          security.hasPassword
                              ? (security.isUnlocked ? 'Unlocked' : 'Locked')
                              : 'No Password Set',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                      ],
                    ),
                    if (security.error != null) ...[
                      const SizedBox(height: 8),
                      Text(security.error!, style: const TextStyle(color: Colors.redAccent, fontSize: 13)),
                    ],
                    const SizedBox(height: 12),
                    if (!security.hasPassword) ...[
                      TextField(
                        controller: _passwordController,
                        obscureText: _obscurePassword,
                        decoration: InputDecoration(
                          labelText: 'Set password (min 8 chars)',
                          suffixIcon: IconButton(
                            icon: Icon(_obscurePassword ? Icons.visibility : Icons.visibility_off),
                            onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
                          ),
                        ),
                      ),
                      const SizedBox(height: 8),
                      FilledButton(
                        onPressed: () => _setPassword(),
                        child: const Text('Set Password'),
                      ),
                    ] else if (security.isUnlocked) ...[
                      if (security.biometricAvailable) ...[
                        SwitchListTile(
                          title: const Text('Biometric Unlock'),
                          subtitle: const Text('Use fingerprint or face to unlock'),
                          value: security.biometricEnabled,
                          onChanged: (v) {
                            if (v) {
                              ref.read(securityProvider.notifier).enableBiometrics();
                            } else {
                              ref.read(securityProvider.notifier).disableBiometrics();
                            }
                          },
                        ),
                        const Divider(),
                      ],
                      FilledButton.tonal(
                        onPressed: () => ref.read(securityProvider.notifier).lock(),
                        child: const Text('Lock Wallet'),
                      ),
                    ] else ...[
                      TextField(
                        controller: _passwordController,
                        obscureText: _obscurePassword,
                        decoration: InputDecoration(
                          labelText: 'Enter password',
                          suffixIcon: IconButton(
                            icon: Icon(_obscurePassword ? Icons.visibility : Icons.visibility_off),
                            onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
                          ),
                        ),
                      ),
                      const SizedBox(height: 8),
                      FilledButton(
                        onPressed: () => _unlock(),
                        child: const Text('Unlock'),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Network selection
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Network', style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 8),
                    ...NetworkId.values.map((id) {
                      final info = NetworkInfo.fromId(id);
                      final alive = network.isAlive(id);
                      final isSelected = network.selectedNetwork == id;
                      return RadioListTile<NetworkId>(
                        value: id,
                        groupValue: network.selectedNetwork,
                        onChanged: (v) {
                          if (v != null) ref.read(networkProvider.notifier).selectNetwork(v);
                        },
                        title: Row(
                          children: [
                            Text(info.label, style: TextStyle(fontWeight: isSelected ? FontWeight.bold : FontWeight.normal)),
                            const SizedBox(width: 8),
                            Container(
                              width: 8,
                              height: 8,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: alive ? Colors.green : Colors.grey,
                              ),
                            ),
                          ],
                        ),
                        subtitle: Text(info.chainIdHex, style: const TextStyle(fontSize: 12)),
                      );
                    }),
                    const SizedBox(height: 8),
                    TextButton.icon(
                      onPressed: network.checkingLiveness
                          ? null
                          : () => ref.read(networkProvider.notifier).checkLiveness(),
                      icon: const Icon(Icons.refresh),
                      label: const Text('Check Liveness'),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Direct Submit config
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Direct Submit', style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 8),
                    Text(
                      'Default destination:',
                      style: const TextStyle(color: Colors.grey, fontSize: 13),
                    ),
                    const SizedBox(height: 4),
                    ...AppConfig.directSubmitAllowlist.map((url) {
                      return RadioListTile<String>(
                        value: url,
                        groupValue: submit.defaultDestination,
                        onChanged: (v) {
                          if (v != null) ref.read(directSubmitProvider.notifier).setDefaultDestination(v);
                        },
                        title: Text(url.replaceAll('https://', '').replaceAll('http://', ''), style: const TextStyle(fontSize: 13)),
                        dense: true,
                      );
                    }),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _setPassword() async {
    final ok = await ref.read(securityProvider.notifier).setPassword(_passwordController.text);
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Password must be at least 8 characters.')),
      );
    }
    _passwordController.clear();
  }

  void _unlock() async {
    final ok = await ref.read(securityProvider.notifier).unlock(_passwordController.text);
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Invalid password.')),
      );
    }
    _passwordController.clear();
  }
}
