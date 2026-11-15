{
  "targets": [
    {
      "target_name": "jw_native_audio",
      "sources": [
        "src/addon.cpp",
        "src/wasapi_probe.cpp",
        "src/miniaudio_impl.c",
        "src/speex_resampler_impl.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "vendor/miniaudio",
        "vendor/speexdsp",
        "vendor/speexdsp/speex"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "OUTSIDE_SPEEX",
        "RANDOM_PREFIX=jwspx",
        "FLOATING_POINT",
        "USE_SSE",
        "USE_SSE2"
      ],
      "cflags_cc": ["-std=c++17"],
      "conditions": [
        ["OS=='win'", {
          "defines": ["_WIN32_WINNT=0x0A00", "WIN32_LEAN_AND_MEAN", "NOMINMAX", "_CRT_SECURE_NO_WARNINGS"],
          "libraries": ["ole32.lib", "user32.lib", "avrt.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17", "/utf-8", "/wd4244", "/wd4267", "/wd4996"]
            }
          }
        }]
      ]
    },
    {
      "target_name": "jw_remote_input",
      "sources": ["src/remote_input.cpp"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_VERSION=8", "NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags_cc": ["-std=c++17"],
      "conditions": [
        ["OS=='win'", {
          "defines": ["_WIN32_WINNT=0x0A00", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
          "libraries": ["user32.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/std:c++17", "/utf-8"]
            }
          }
        }]
      ]
    }
  ]
}
