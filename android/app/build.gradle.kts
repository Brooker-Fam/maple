import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// The upload key lives outside the repo; keystore.properties (gitignored) points at it.
val uploadKey = rootProject.file("keystore.properties").takeIf { it.exists() }?.let { f ->
    Properties().apply { f.inputStream().use { load(it) } }
}

val mapleBaseUrl: String = (findProperty("mapleBaseUrl") as String? ?: "https://maplebaby.app")
    .trimEnd('/')
    .also {
        // Plain http only for a dev server on this Mac, which only debug builds' network config lets through.
        val local = Regex("^http://(10\\.0\\.2\\.2|localhost|127\\.0\\.0\\.1)(:[0-9]+)?$")
        require(Regex("^https://[A-Za-z0-9.-]+(:[0-9]+)?$").matches(it) || local.matches(it)) {
            "mapleBaseUrl must be an https origin (or http://10.0.2.2:<port> for a dev server), got $it"
        }
    }

android {
    namespace = "family.brooker.maple"
    compileSdk = 36

    defaultConfig {
        applicationId = "family.brooker.maple"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "MAPLE_BASE_URL", "\"$mapleBaseUrl\"")
    }

    signingConfigs {
        if (uploadKey != null) {
            create("upload") {
                storeFile = file(uploadKey.getProperty("storeFile"))
                storePassword = uploadKey.getProperty("storePassword")
                keyAlias = uploadKey.getProperty("keyAlias")
                keyPassword = uploadKey.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfigs.findByName("upload")?.let { signingConfig = it }
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    buildFeatures {
        buildConfig = true
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.activity.compose)
    implementation(libs.browser)
    implementation(libs.webkit)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
}
