import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const uri = this.configService.get<string>('REDIS_URI');
    if (!uri) {
      throw new Error('REDIS_URI environment variable is not set');
    }

    // Allow self-signed certs in dev/staging (e.g. Aiven).
    // Set REDIS_TLS_REJECT_UNAUTHORIZED=true in production to enforce strict TLS.
    const rejectUnauthorized =
      this.configService.get<string>(
        'REDIS_TLS_REJECT_UNAUTHORIZED',
        'false',
      ) === 'true';

    this.client = new Redis(uri, {
      tls: {
        rejectUnauthorized,
      },
      retryStrategy: (times) => {
        const delay = Math.min(times * 500, 10_000);
        this.logger.warn(
          `Redis reconnect attempt #${times}, waiting ${delay}ms`,
        );
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
      lazyConnect: false,
    });

    this.client.on('connect', () => this.logger.log('Connected to Redis'));
    this.client.on('ready', () => this.logger.log('Redis client ready'));
    this.client.on('error', (err) =>
      this.logger.error('Redis error', err.message),
    );
    this.client.on('close', () => this.logger.warn('Redis connection closed'));
  }

  getClient(): Redis {
    return this.client;
  }

  async onModuleDestroy() {
    await this.client.quit();
    this.logger.log('Redis client disconnected');
  }
}
