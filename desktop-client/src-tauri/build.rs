fn main() {
    println!("cargo:rerun-if-changed=../scripts/split-pdf.swift");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        std::fs::create_dir_all("resources").unwrap();
        let arch = if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("aarch64") {
            "arm64"
        } else {
            "x86_64"
        };
        let target = format!("{arch}-apple-macos13.0");
        let status = std::process::Command::new("swiftc")
            .args(["-target", &target])
            .args([
                "-O",
                "../scripts/split-pdf.swift",
                "-o",
                "resources/pdf-split",
            ])
            .status()
            .expect("Compile system PDF adapter");
        assert!(status.success(), "System PDF adapter failed to compile");
    }
    tauri_build::build();
}
