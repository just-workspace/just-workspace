# 브랜드 APK 자동빌드용 이미지 (JDK21 + Node24 + Android SDK36). 1회 빌드 후 백엔드가 재사용.
#   docker build -f apps/mobile/builder.Dockerfile -t jw-android-builder apps/mobile
FROM eclipse-temurin:21-jdk

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends curl unzip ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y -qq nodejs \
    && rm -rf /var/lib/apt/lists/*

ENV ANDROID_SDK_ROOT=/opt/android-sdk
RUN mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools" && cd /tmp \
    && curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o c.zip \
    && unzip -q c.zip && mv cmdline-tools "$ANDROID_SDK_ROOT/cmdline-tools/latest" && rm c.zip \
    && yes | "$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null 2>&1 || true \
    && "$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" "platform-tools" "platforms;android-36" "build-tools;36.0.0" >/dev/null 2>&1

COPY builder-build.sh /build.sh
RUN chmod +x /build.sh
ENTRYPOINT ["/build.sh"]
