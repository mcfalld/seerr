import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBlockAdult1770627987305 implements MigrationInterface {
  name = 'AddBlockAdult1770627987305';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD COLUMN "blockAdult" boolean NOT NULL DEFAULT (0)`
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async down(queryRunner: QueryRunner): Promise<void> {
    // Forward-only migration for SQLite
  }
}
