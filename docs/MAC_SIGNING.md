# macOS 서명

macOS는 개인정보 권한(문서·다운로드 폴더, 앱 관리, 전체 디스크 접근)과 키체인 항목의 접근 목록을 "번들 ID + 서명"에 묶어 둔다. ad-hoc 서명(`codesign --sign -`)은 코드 해시일 뿐이라 빌드·업데이트마다 서명이 바뀌고, 그때마다 권한을 다시 묻거나 "앱을 수정하려는 시도를 차단했습니다"가 뜬다. 릴리스는 한 번 만든 자체 서명 인증서로 서명해서 이를 막는다. Apple 개발자 계정은 필요 없다(공증은 하지 않으므로 처음 받은 앱의 Gatekeeper 경고는 그대로다).

- 서명 조건은 `identifier "com.mooner.ade" and certificate leaf = H"<인증서 지문>"`이다. 인증서가 같으면 업데이트 후에도 사용자 PC의 승인이 유지되고, 사용자 PC에 인증서를 설치하거나 신뢰할 필요가 없다.
- 인증서를 바꾸면 모든 사용자가 승인을 한 번 더 해야 한다. `.p12`는 잃어버리지 않게 보관하고, 저장소에는 넣지 않는다.
- macOS 업데이트는 서명된 전체 zip만 쓴다(앱 단독 zip 없음). 번들 안 파일을 바꾸면 서명이 깨지고, 사용자 PC에서는 이 인증서로 다시 서명할 수 없다. 업데이터는 인증서로 서명된 설치본에 다른 서명의 업데이트를 설치하지 않는다.
- `pnpm dev`의 번들은 `com.mooner.ade.dev`(ad-hoc)라서 설치본의 권한을 덮어쓰지 않는다.

## 인증서 만들기 (한 번)

```sh
mkdir -p ~/.mooner-signing && cd ~/.mooner-signing
cat > cs.cnf <<'CNF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = MoonerADE Code Signing
[ext]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
CNF
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout key.pem -out cert.pem -config cs.cnf
/usr/bin/openssl pkcs12 -export -inkey key.pem -in cert.pem -out moonerade.p12 -name "MoonerADE Code Signing"   # 비밀번호를 정한다. macOS 기본 LibreSSL을 써야 키체인이 읽는 형식이 나온다(Homebrew OpenSSL 3은 -legacy 필요)
```

이 Mac에 넣고(서명하는 쪽만 필요한 단계) 신뢰한다. 신뢰하지 않은 인증서로는 `codesign`이 "no identity found"를 낸다.

```sh
security import moonerade.p12 -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign
security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db cert.pem
security find-identity -v -p codesigning   # "MoonerADE Code Signing"이 보여야 한다
```

로컬에서 서명된 앱을 만들려면 `ADE_SIGN_IDENTITY="MoonerADE Code Signing" pnpm package`.

## GitHub Actions

저장소 시크릿 두 개를 넣는다. 릴리스 워크플로가 임시 키체인에 인증서를 가져와 신뢰하고 서명한다(시크릿이 없으면 macOS 빌드가 실패한다. ad-hoc 릴리스가 조용히 나가지 않게 하기 위해서다).

```sh
base64 -i ~/.mooner-signing/moonerade.p12 | gh secret set MACOS_SIGN_P12 --repo Mooner510/mooner-ade
gh secret set MACOS_SIGN_P12_PASSWORD --repo Mooner510/mooner-ade   # .p12 비밀번호
```

## 전환 직후

기존 설치본의 승인은 옛 코드 해시에 묶여 있어서, 인증서로 서명된 첫 버전에서 승인을 한 번 다시 해야 한다. 이전 항목이 남아 있으면 `tccutil reset All com.mooner.ade` 뒤에 다시 허용한다.
