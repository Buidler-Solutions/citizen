class ProfileDetails {
  final String fullName;
  final String email;
  final String address;
  final String profession;
  final bool kycVerified;

  const ProfileDetails({
    this.fullName = '',
    this.email = '',
    this.address = '',
    this.profession = '',
    this.kycVerified = false,
  });

  ProfileDetails copyWith({
    String? fullName,
    String? email,
    String? address,
    String? profession,
    bool? kycVerified,
  }) {
    return ProfileDetails(
      fullName: fullName ?? this.fullName,
      email: email ?? this.email,
      address: address ?? this.address,
      profession: profession ?? this.profession,
      kycVerified: kycVerified ?? this.kycVerified,
    );
  }

  Map<String, dynamic> toJson() => {
        'fullName': fullName,
        'email': email,
        'address': address,
        'profession': profession,
        'kycVerified': kycVerified,
      };

  factory ProfileDetails.fromJson(Map<String, dynamic> json) {
    return ProfileDetails(
      fullName: json['fullName'] as String? ?? '',
      email: json['email'] as String? ?? '',
      address: json['address'] as String? ?? '',
      profession: json['profession'] as String? ?? '',
      kycVerified: json['kycVerified'] as bool? ?? false,
    );
  }
}
