# Natural self-play — round 3
time ./training/gen_batch.sh 80000 3 8 120 0 shard-r3 9000

# Material augmentation — round 3
time ./training/augment_batch.sh 80000 3 8 4000 augment-shard-r3 10000

# Seeded self-play — round 3
time ./training/gen_batch.sh 80000 3 8 120 0.5 seeded-shard-r3 11000
