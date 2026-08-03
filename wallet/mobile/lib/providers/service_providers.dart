import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/services/crypto_service.dart';
import '../data/services/mnemonic_service.dart';
import '../data/services/storage_service.dart';
import '../data/services/citizen_api_service.dart';

final cryptoServiceProvider = Provider<CryptoService>((ref) => CryptoService());
final mnemonicServiceProvider = Provider<MnemonicService>((ref) => MnemonicService());
final storageServiceProvider = Provider<StorageService>((ref) => StorageService());
final citizenApiServiceProvider = Provider<CitizenApiService>((ref) => CitizenApiService());
