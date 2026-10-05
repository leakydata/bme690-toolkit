// Board A smoke test for an ESP32-S3 (Arduino core 3.x, e.g. ESP32-S3 DevKitC-1).
//
// MODE_I2C: a single-sensor shuttle. Scans the I2C bus and reads the chip ID
//           register (0xD0) of a BME690 at 0x76; expect 0x61.
// MODE_SPI: the BME690 8x shuttle. Reads the chip ID of all eight sensors
//           over SPI, one chip select each; expect 0x61 from every one.
//
// Wiring (Board A header -> ESP32-S3), the same for both modes:
//   VIO and VDD -> 3V3 (TIE jumper closed: one wire to VIO is enough)
//   GND -> GND
//   SCK -> GPIO12   (SCL in I2C mode)
//   SDI -> GPIO11   (SDA in I2C mode)
//   SDO -> GPIO13   (in I2C mode the sketch drives it low: address 0x76)
//   0..7 -> GPIO1, 2, 4, 5, 6, 7, 15, 16   (8x shuttle chip selects)
//   CS  -> leave open for I2C (the board's 10k pull-up selects I2C)
// Never connect 5 V to the shuttle.

#include <Arduino.h>
#include <SPI.h>
#include <Wire.h>

#define MODE_SPI 1   // 1 = 8x shuttle over SPI, 0 = single shuttle over I2C

const int PIN_SCK = 12;
const int PIN_SDI = 11;
const int PIN_SDO = 13;
const int CS_PINS[8] = {1, 2, 4, 5, 6, 7, 15, 16};

const uint8_t CHIP_ID_REG = 0xD0;
const uint8_t CHIP_ID_BME690 = 0x61;

// ------------------------------------------------------------------ SPI

SPISettings spiSettings(1000000, MSBFIRST, SPI_MODE0);

uint8_t spiRead(int cs, uint8_t addr) {
  SPI.beginTransaction(spiSettings);
  digitalWrite(cs, LOW);
  SPI.transfer(addr | 0x80);
  uint8_t value = SPI.transfer(0x00);
  digitalWrite(cs, HIGH);
  SPI.endTransaction();
  return value;
}

void spiWrite(int cs, uint8_t addr, uint8_t value) {
  SPI.beginTransaction(spiSettings);
  digitalWrite(cs, LOW);
  SPI.transfer(addr & 0x7F);
  SPI.transfer(value);
  digitalWrite(cs, HIGH);
  SPI.endTransaction();
}

// In SPI mode the registers sit in two pages; the chip ID (0xD0) is in the
// page selected by bit 4 of the status register (0x73) being 0, where it
// is read at SPI address 0x50.
uint8_t readChipIdSpi(int cs) {
  spiRead(cs, 0x73);                       // first access puts the sensor in SPI mode
  uint8_t status = spiRead(cs, 0x73);
  spiWrite(cs, 0x73, status & ~0x10);
  return spiRead(cs, 0x50);
}

void testSpi() {
  Serial.println("SPI chip ID check, 8x shuttle");
  SPI.begin(PIN_SCK, PIN_SDO, PIN_SDI, -1);
  for (int i = 0; i < 8; i++) {
    pinMode(CS_PINS[i], OUTPUT);
    digitalWrite(CS_PINS[i], HIGH);
  }
  delay(5);
  int good = 0;
  for (int i = 0; i < 8; i++) {
    uint8_t id = readChipIdSpi(CS_PINS[i]);
    bool ok = (id == CHIP_ID_BME690);
    if (ok) {
      good++;
    }
    Serial.printf("  sensor %d (U%d, header %d, GPIO%d): chip ID 0x%02X %s\n",
                  i, i + 1, i, CS_PINS[i], id, ok ? "OK" : "<- check this chip select");
  }
  Serial.printf("%d of 8 sensors answered as BME690\n", good);
}

// ------------------------------------------------------------------ I2C

void testI2c() {
  Serial.println("I2C scan, single-sensor shuttle");
  pinMode(PIN_SDO, OUTPUT);
  digitalWrite(PIN_SDO, LOW);              // SDO low = address 0x76; it must not float
  delay(5);
  Wire.begin(PIN_SDI, PIN_SCK, 100000);
  int found = 0;
  for (uint8_t addr = 0x08; addr < 0x78; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("  device at 0x%02X\n", addr);
      found++;
    }
  }
  if (found == 0) {
    Serial.println("  nothing found: check power, SCK/SDI, and that the SDA/SCL jumpers are closed");
    return;
  }
  Wire.beginTransmission(0x76);
  Wire.write(CHIP_ID_REG);
  if (Wire.endTransmission(false) != 0 || Wire.requestFrom(0x76, 1) != 1) {
    Serial.println("  no answer at 0x76");
    return;
  }
  uint8_t id = Wire.read();
  Serial.printf("  0x76 chip ID 0x%02X %s\n", id, id == CHIP_ID_BME690 ? "= BME690 OK" : "(not a BME690)");
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println();
  Serial.println("Board A smoke test");
  if (MODE_SPI) {
    testSpi();
  } else {
    testI2c();
  }
}

void loop() {
  delay(5000);
  setup();
}
