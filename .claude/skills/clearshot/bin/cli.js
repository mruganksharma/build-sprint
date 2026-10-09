#!/usr/bin/env node

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const REPO_URL = "https://github.com/udayanwalvekar/clearshot.git";
const INSTALL_DIR = path.join(os.homedir(), ".claude", "skills", "clearshot");

function main() {
  console.log("\nclearshot - structured screenshot intelligence\n");

  try {
    // Step 1: Remove symlinks (handles broken/circular ones)
    try {
      const lstat = fs.lstatSync(INSTALL_DIR);
      if (lstat.isSymbolicLink()) {
        console.log("symlink detected at " + INSTALL_DIR + ", removing...");
        fs.unlinkSync(INSTALL_DIR);
      }
    } catch (e) {
      if (e.code !== "ENOENT") {
        try { fs.unlinkSync(INSTALL_DIR); } catch (_) {}
      }
    }

    // Step 2: Update existing installation
    if (fs.existsSync(path.join(INSTALL_DIR, ".git"))) {
      console.log("existing installation found, updating...");
      execSync("git -C " + JSON.stringify(INSTALL_DIR) + " pull", { stdio: "inherit" });
    } else {
      // Step 3: Fresh clone
      console.log("installing to " + INSTALL_DIR + "...");
      fs.mkdirSync(path.dirname(INSTALL_DIR), { recursive: true });
      execSync("git clone " + REPO_URL + " " + JSON.stringify(INSTALL_DIR), { stdio: "inherit" });
    }

    // Step 4: Run setup
    console.log("running setup...");
    execSync("./setup", { cwd: INSTALL_DIR, stdio: "inherit" });

    console.log("\ndone. clearshot is ready.");
    console.log("activates automatically when you share a UI screenshot.\n");
  } catch (err) {
    console.error("\ninstallation failed. paste this into claude code instead:");
    console.error("  git clone " + REPO_URL + " " + INSTALL_DIR + " && " + INSTALL_DIR + "/setup\n");
    process.exit(1);
  }
}

main();
