import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:citizen_wallet_mobile/main.dart';

void main() {
  testWidgets('App renders lock or main screen', (tester) async {
    await tester.pumpWidget(
      const ProviderScope(child: CitizenWalletApp()),
    );
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byType(MaterialApp), findsOneWidget);
  });
}
