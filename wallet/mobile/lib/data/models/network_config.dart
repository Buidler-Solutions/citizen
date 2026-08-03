enum NetworkId { mainnet, futurenet, testnet, localnode }

class NetworkInfo {
  final NetworkId id;
  final String chainIdHex;
  final String label;
  final String healthUrl;

  const NetworkInfo({
    required this.id,
    required this.chainIdHex,
    required this.label,
    required this.healthUrl,
  });

  String get apiBaseUrl {
    switch (id) {
      case NetworkId.mainnet:
        return 'https://mainnet.ctzn.space';
      case NetworkId.futurenet:
        return 'https://futurenet.ctzn.space';
      case NetworkId.testnet:
        return 'https://testnet.ctzn.space';
      case NetworkId.localnode:
        return 'http://localhost:8081';
    }
  }

  static const Map<NetworkId, NetworkInfo> all = {
    NetworkId.mainnet: NetworkInfo(
      id: NetworkId.mainnet,
      chainIdHex: '0xc17',
      label: 'Mainnet',
      healthUrl: 'https://mainnet.ctzn.space/health',
    ),
    NetworkId.futurenet: NetworkInfo(
      id: NetworkId.futurenet,
      chainIdHex: '0xc18',
      label: 'Futurenet',
      healthUrl: 'https://futurenet.ctzn.space/health',
    ),
    NetworkId.testnet: NetworkInfo(
      id: NetworkId.testnet,
      chainIdHex: '0xc19',
      label: 'Testnet',
      healthUrl: 'https://testnet.ctzn.space/health',
    ),
    NetworkId.localnode: NetworkInfo(
      id: NetworkId.localnode,
      chainIdHex: '0x539',
      label: 'Local Node',
      healthUrl: 'http://localhost:8081/health',
    ),
  };

  static NetworkInfo fromId(NetworkId id) => all[id]!;
}

String networkIdToString(NetworkId id) => id.name;

NetworkId networkIdFromString(String value) {
  return NetworkId.values.firstWhere(
    (e) => e.name == value,
    orElse: () => NetworkId.mainnet,
  );
}
