import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBlockUnrated1765557160381 implements MigrationInterface {
  name = 'AddBlockUnrated1765557160381';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD COLUMN "blockUnrated" boolean NOT NULL DEFAULT (0)`
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async down(queryRunner: QueryRunner): Promise<void> {
    // Forward-only migration for SQLite
  }
}
