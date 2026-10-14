plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Version is injected by CI via -PappVersionName / -PappVersionCode (see .github/workflows).
// Falls back to sensible defaults for local dev builds.
val appVersionName: String = (project.findProperty("appVersionName") as String?) ?: "0.0.0-dev"
val appVersionCode: Int = (project.findProperty("appVersionCode") as String?)?.toIntOrNull() ?: 1

// Release signing: use a real keystore when the env vars are present (stable
// signature across releases), otherwise fall back to the debug key so the APK
// is still installable with zero setup.
val ksPath: String? = System.getenv("ANDROID_KEYSTORE_FILE")
val hasReleaseKeystore = !ksPath.isNullOrEmpty() && file(ksPath).exists()

android {
    namespace = "com.phonemcp.agent"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.phonemcp.agent"
        minSdk = 26 // Android 8.0 — dispatchGesture requires API 24+, foreground services need 26+
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
    }

    buildFeatures {
        viewBinding = true
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(ksPath!!)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (hasReleaseKeystore) {
                signingConfigs.getByName("release")
            } else {
                // Debug key → still installable on real phones (sideload).
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
