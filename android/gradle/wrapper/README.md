# Gradle wrapper

`gradle-wrapper.jar` (Gradle 8.9) is committed, so `./gradlew` works out of the
box — no local Gradle install needed. CI and local builds both use the wrapper:

```bash
cd android && ./gradlew assembleDebug     # or assembleRelease
```

Android Studio also uses this wrapper automatically when you open `android/`.
