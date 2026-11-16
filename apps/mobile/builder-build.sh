#!/bin/sh
# 사이트 전용 APK 빌드 — /src(apps/mobile, ro 마운트)를 복사해 사이트 값을 주입하고 서명된 release APK 를 생성한다.
# 산출물: /out/apps/workspace-android.apk  (out = 워크스페이스 storage 볼륨)
#
# 환경:
#   WS_URL     대상 워크스페이스 주소 (필수, https://ws.example.com)
#   APP_ID     기본: 호스트를 역순으로 하고 .workspace 를 덧붙임 (ws.example.com → com.example.ws.workspace).
#              배포 후에는 변경 금지 — 변경 시 별개의 앱으로 취급된다.
#   APP_NAME   기본: Just Workspace (런처에 표시되는 이름)
#   JW_WEB_BUNDLE  1 이면 웹 화면을 앱에 포함한다(번들 모드). frontend-react 소스를
#              /web 에 ro 마운트해야 한다(-v <repo>/frontend-react:/web:ro). 기본은 원격 모드(서버 웹을 그대로 연다).
#
# 서명 키는 최초 빌드 시 /signing(별도 볼륨 jw-android-signing)에 생성하고 이후 계속 사용한다. 키가 변경되면 설치된 앱이
# 갱신 설치를 거부하므로 해당 볼륨은 백업 대상이다.
set -e
export ANDROID_SDK_ROOT=/opt/android-sdk

[ -n "$WS_URL" ] || { echo "WS_URL 이 필요하다" >&2; exit 1; }
WS_URL=$(printf '%s' "$WS_URL" | sed 's:/*$::')
HOST=$(printf '%s' "$WS_URL" | sed -E 's#^https?://##; s#[:/].*$##')
[ -n "$HOST" ] || { echo "WS_URL 에서 호스트를 못 읽었다: $WS_URL" >&2; exit 1; }
if [ -z "$APP_ID" ]; then
  APP_ID="$(printf '%s' "$HOST" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9.\n' '_' \
    | awk -F. '{for(i=NF;i>0;i--) printf "%s%s", $i, (i>1?".":"")}').workspace"
fi
APP_NAME=${APP_NAME:-Just Workspace}
VERSION_CODE=$(( $(date +%s) / 60 ))          # 빌드마다 증가해야 갱신 설치가 가능하다
VERSION_NAME=$(date -u +%Y.%m.%d.%H%M)
export WS_URL APP_ID APP_NAME JW_WEB_BUNDLE
echo "[site] $WS_URL  id=$APP_ID  name=$APP_NAME${JW_WEB_BUNDLE:+  bundle=$JW_WEB_BUNDLE}  v$VERSION_NAME ($VERSION_CODE)"

cp -r /src /work
cd /work
echo "sdk.dir=$ANDROID_SDK_ROOT" > android/local.properties

# node_modules는 repo에 없음(gitignore) → 설치
echo "[npm] install..."
npm install --no-audit --no-fund 2>&1 | tail -3

# 번들 모드: 웹 화면을 이 주소로 빌드해 www-react/ 에 두고 이를 webDir 로 sync 한다
if [ "$JW_WEB_BUNDLE" = "1" ]; then
  [ -f /web/package.json ] || { echo "JW_WEB_BUNDLE=1 인데 /web(frontend-react) 마운트가 없다" >&2; exit 1; }
  rm -rf /work-web && mkdir -p /work-web
  (cd /web && tar --exclude=./node_modules --exclude=./dist -cf - .) | tar -C /work-web -xf -
  JW_WEB_SRC=/work-web node scripts/bundle-web.cjs
  export JW_WEB_DIR=www-react
fi

# 최신 web/config 동기화(android assets capacitor.config.json 생성) 후 사이트 값 주입
npx --no-install cap sync android 2>&1 | tail -3
node scripts/bake-site.cjs

# 서명 키 (사이트마다 하나, 영구)
SIGN=/signing
mkdir -p "$SIGN"
if [ ! -f "$SIGN/release.keystore" ]; then
  echo "[sign] 새 서명 키 생성 → $SIGN (백업할 것)"
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$SIGN/password"
  keytool -genkeypair -noprompt -keystore "$SIGN/release.keystore" -storetype PKCS12 -alias jw \
    -keyalg RSA -keysize 3072 -validity 36500 -dname "CN=$HOST" \
    -storepass "$(cat "$SIGN/password")" -keypass "$(cat "$SIGN/password")" >/dev/null
  chmod 600 "$SIGN/release.keystore" "$SIGN/password"
fi

cd android
chmod +x gradlew
./gradlew assembleRelease --no-daemon -q \
  -PjwAppId="$APP_ID" -PjwVersionCode="$VERSION_CODE" -PjwVersionName="$VERSION_NAME" \
  -PjwKeystore="$SIGN/release.keystore" -PjwKeystorePassword="$(cat "$SIGN/password")" 2>&1 | tail -12
APK=app/build/outputs/apk/release/app-release.apk
[ -f "$APK" ] || { echo "APK 가 안 나왔다" >&2; exit 1; }
mkdir -p /out/apps
cp "$APK" /out/apps/workspace-android.apk.tmp
mv /out/apps/workspace-android.apk.tmp /out/apps/workspace-android.apk
echo BUILD_OK
