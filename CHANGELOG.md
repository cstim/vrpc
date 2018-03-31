# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

This CHANGELOG.md file

### Changed

- Renamed source folder `cpp` into `vrpc`, needed to please python's setup tools
  - Moved all non-test code into the new `vrpc` folder
  - Adapted all paths involving the old `cpp` folder
  - Adapted the `binding.gyp` template in `README.md`
  - Keeping backwards compatibility by generating `cpp` symbolic link
- Renamed environmental BUILD_TESTS to BUILD_TEST (has no external effect)

### Fixed

- Python proxy constructor to be callable with variadic arguments


## [1.0.2] - 16 Mar 2018

### Changed

- Link address to the C++ json library in README.md

### Removed

- Unnecessary npm-dependency `shortid`



## [1.0.1] - 14 Mar 2018

### Added

- Link to nodejs project example in README.md

### Fixed

- Typo and missing brace in README.md



## [1.0.0] - 14 Mar 2018

First public release