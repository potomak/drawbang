# Redis development db folder

## Backup RedisToGo production data

Run

    heroku config

to get RedisToGo auth data.

Copy development configuration to a new file

    cp config/redis.conf config/redis_backup.conf

Update configuration of replica instance

    slaveof <masterip> <masterport>
    masterauth <master-password>

where `<masterip>`, `<masterport>` and `<master-password>` are taken from `REDISTOGO_URL` heroku config attribute.

Update configuration of database filename

    dbfilename production_dump_<date>.rdb

to avoid overwriting of development database dump.

Start Redis on a local machine (or the machine you wish to export to) using the configuration file that was just set up

    redis-server config/redis_backup.conf

See more at https://redistogo.com/documentation/exporting