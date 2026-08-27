plugins {
    id("com.android.application")
}

android {
    namespace = "jp.local.aichat.device"
    compileSdk = 36

    defaultConfig {
        applicationId = "jp.local.aichat.device"
        // Echo Spot 初代に入る LineageOS 18.1 = Android 11。
        minSdk = 30
        targetSdk = 30
        versionCode = 1
        versionName = "0.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // **依存はこれだけ。** androidx も Compose も入れない。
    // 画面は View を数個組むだけで、増やすほど据え置きの機械では負債になる。
    // **5.x にしない。** 5.x は okhttp-android を引き込み、compileSdk 37 を
    // 要求してくる。Android 11 に載せる据え置きの機械に、プレビュー SDK は要らない。
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
