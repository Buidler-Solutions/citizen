import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:treasurenet_mobile/presentation/widgets/finality_receipt_card.dart';

void main() {
  testWidgets('FinalityReceiptCard renders receipt proof fields',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: FinalityReceiptCard(
            receiptId: 'rcpt-escrow-claim-esc-h1-1042-7',
            blockHeight: 1042,
            reward: '500 CTZN',
            commitProof: 'proof:rcpt-escrow-claim-esc-h1-1042-7',
          ),
        ),
      ),
    );

    expect(find.text('Finality receipt'), findsOneWidget);
    expect(find.text('reward 500 CTZN'), findsOneWidget);
    expect(find.text('receipt rcpt-escrow-claim-esc-h1-1042-7'), findsOneWidget);
    expect(find.text('block height 1042'), findsOneWidget);
    expect(find.text('proof proof:rcpt-escrow-claim-esc-h1-1042-7'),
        findsOneWidget);
  });

  testWidgets('FinalityReceiptCard tolerates pending values',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: FinalityReceiptCard()),
      ),
    );
    expect(find.text('receipt pending'), findsOneWidget);
    expect(find.text('block height ?'), findsOneWidget);
  });
}
